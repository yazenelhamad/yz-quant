import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Envelope encryption for secrets at rest (broker tokens, MFA secrets).
 * Format: v1:<keyVersion>:<iv b64>:<tag b64>:<ciphertext b64>
 * Keys are looked up by version so rotation is possible without downtime.
 */
export class SecretBox {
  private readonly keys: Map<number, Buffer>;
  constructor(keys: { version: number; key: Buffer }[], private readonly currentVersion: number) {
    this.keys = new Map(keys.map((k) => [k.version, k.key]));
    for (const k of this.keys.values()) if (k.length !== 32) throw new Error("SecretBox keys must be 32 bytes");
    if (!this.keys.has(currentVersion)) throw new Error("current key version missing");
  }

  static fromMasterKey(key: Buffer, version = 1): SecretBox {
    return new SecretBox([{ version, key }], version);
  }

  get keyVersion(): number { return this.currentVersion; }

  seal(plaintext: string, aad?: string): string {
    const key = this.keys.get(this.currentVersion)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", String(this.currentVersion), iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
  }

  open(envelope: string, aad?: string): string {
    const parts = envelope.split(":");
    if (parts.length !== 5 || parts[0] !== "v1") throw new Error("Malformed secret envelope");
    const version = Number(parts[1]);
    const key = this.keys.get(version);
    if (!key) throw new Error(`No key for secret envelope version ${version}`);
    const iv = Buffer.from(parts[2]!, "base64");
    const tag = Buffer.from(parts[3]!, "base64");
    const ct = Buffer.from(parts[4]!, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }

  /** Re-encrypt under the current key (for rotation). */
  rotate(envelope: string, aad?: string): string {
    return this.seal(this.open(envelope, aad), aad);
  }

  versionOf(envelope: string): number {
    return Number(envelope.split(":")[1]);
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function maskAccountNumber(n: string | null | undefined): string {
  if (!n) return "••••";
  const tail = n.slice(-4);
  return `••••${tail}`;
}

/** Redact bearer tokens and long secrets from any string destined for logs. */
export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer [redacted]")
    .replace(/(access_token|refresh_token|password|secret|code_verifier)("?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1$2[redacted]");
}
