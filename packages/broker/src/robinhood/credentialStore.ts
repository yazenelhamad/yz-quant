/**
 * Credential persistence for the Robinhood OAuth pair.
 *
 * `CredentialStore` is what the adapter needs: load/save/delete keyed by tenant scope.
 * The DB-backed implementation lives in the API app (out of this package's scope). The API
 * implements the tiny `EnvelopeStore` interface (load/save/delete an opaque string per
 * scope, typically a column on `broker_accounts`) and wraps it in `EncryptedCredentialStore`
 * with an `EncryptedCredentialCodec` built from SECRETS_MASTER_KEY.
 *
 * Envelope format (versioned so keys can rotate without downtime):
 *   v1:<keyVersion>:<iv b64url>:<tag b64url>:<ciphertext b64url>
 * AES-256-GCM, 12-byte IV, 16-byte tag. The tenant scope is bound as AAD, so an envelope
 * copied from user A's row can never be opened under user B's scope.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import type { TenantScope } from "@yz/core";
import { assertScope } from "@yz/core";
import { isCredential, type Credential } from "./oauth.js";

export interface CredentialStore {
  load(scope: TenantScope): Promise<Credential | null>;
  save(scope: TenantScope, cred: Credential): Promise<void>;
  delete(scope: TenantScope): Promise<void>;
}

/** Opaque per-scope string persistence. Implemented over the database by the API app. */
export interface EnvelopeStore {
  load(scope: TenantScope): Promise<string | null>;
  save(scope: TenantScope, envelope: string): Promise<void>;
  delete(scope: TenantScope): Promise<void>;
}

export function scopeKey(scope: TenantScope): string {
  assertScope(scope, "credential store");
  return `${scope.userId}\u0000${scope.brokerAccountId}`;
}

/** AAD binding an envelope to its tenant. */
export function scopeAad(scope: TenantScope): string {
  return `yz-quant:broker-credential:${scope.userId}:${scope.brokerAccountId}`;
}

export interface KeyMaterial {
  version: string;
  key: Uint8Array;
}

export interface KeyRing {
  currentVersion: string;
  keys: Record<string, Uint8Array>;
}

export const ENVELOPE_VERSION = "v1";

export interface ParsedEnvelope {
  version: typeof ENVELOPE_VERSION;
  keyVersion: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

function assertKey(key: Uint8Array, label: string): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error(`${label}: master key must be exactly 32 bytes`);
}

function assertKeyVersion(version: string): void {
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(version)) throw new Error("key version must be 1-32 chars of [A-Za-z0-9_.-]");
}

/** Parses SECRETS_MASTER_KEY: base64/base64url or hex, must decode to 32 bytes. */
export function parseMasterKey(value: string | undefined | null): Uint8Array {
  const v = (value ?? "").trim();
  if (v.length === 0) throw new Error("SECRETS_MASTER_KEY is not set");
  let buf: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(v)) buf = Buffer.from(v, "hex");
  else buf = Buffer.from(v, v.includes("-") || v.includes("_") ? "base64url" : "base64");
  if (buf.byteLength !== 32) throw new Error(`SECRETS_MASTER_KEY must decode to 32 bytes (got ${buf.byteLength})`);
  return new Uint8Array(buf);
}

export function parseEnvelope(envelope: string): ParsedEnvelope {
  const parts = envelope.split(":");
  if (parts.length !== 5) throw new Error("malformed credential envelope");
  const [version, keyVersion, iv, tag, ciphertext] = parts as [string, string, string, string, string];
  if (version !== ENVELOPE_VERSION) throw new Error(`unsupported credential envelope version: ${version}`);
  assertKeyVersion(keyVersion);
  const ivBuf = Buffer.from(iv, "base64url");
  const tagBuf = Buffer.from(tag, "base64url");
  if (ivBuf.byteLength !== 12 || tagBuf.byteLength !== 16) throw new Error("malformed credential envelope");
  return { version: ENVELOPE_VERSION, keyVersion, iv: ivBuf, tag: tagBuf, ciphertext: Buffer.from(ciphertext, "base64url") };
}

export function sealEnvelope(plaintext: string, key: KeyMaterial, aad?: string, random: (n: number) => Uint8Array = (n) => new Uint8Array(randomBytes(n))): string {
  assertKey(key.key, "seal");
  assertKeyVersion(key.version);
  const iv = Buffer.from(random(12));
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key.key), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENVELOPE_VERSION, key.version, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
}

export function openEnvelope(envelope: string, key: KeyMaterial, aad?: string): string {
  assertKey(key.key, "open");
  const parsed = parseEnvelope(envelope);
  if (parsed.keyVersion !== key.version) throw new Error(`envelope was sealed with key version ${parsed.keyVersion}, not ${key.version}`);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key.key), parsed.iv);
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(parsed.tag);
  try {
    return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("credential envelope authentication failed");
  }
}

/** Re-seals an envelope under a new key (and/or new version) without exposing the plaintext to callers. */
export function rotateEnvelope(envelope: string, oldKey: KeyMaterial, newKey: KeyMaterial, aad?: string): string {
  const plain = openEnvelope(envelope, oldKey, aad);
  return sealEnvelope(plain, newKey, aad);
}

/** Encrypts/decrypts `Credential` objects with a key ring so that old envelopes still open during a rotation. */
export class EncryptedCredentialCodec {
  private readonly ring: KeyRing;

  constructor(keys: KeyRing | KeyMaterial | Uint8Array) {
    if (keys instanceof Uint8Array) {
      assertKey(keys, "codec");
      this.ring = { currentVersion: "k1", keys: { k1: keys } };
    } else if ("currentVersion" in keys) {
      if (!(keys.currentVersion in keys.keys)) throw new Error("key ring has no key for its current version");
      for (const [v, k] of Object.entries(keys.keys)) {
        assertKeyVersion(v);
        assertKey(k, `codec key ${v}`);
      }
      this.ring = { currentVersion: keys.currentVersion, keys: { ...keys.keys } };
    } else {
      assertKeyVersion(keys.version);
      assertKey(keys.key, "codec");
      this.ring = { currentVersion: keys.version, keys: { [keys.version]: keys.key } };
    }
  }

  get currentKeyVersion(): string {
    return this.ring.currentVersion;
  }

  private material(version: string): KeyMaterial {
    const key = this.ring.keys[version];
    if (!key) throw new Error(`no key for envelope key version ${version}`);
    return { version, key };
  }

  encrypt(cred: Credential, aad?: string): string {
    if (!isCredential(cred)) throw new Error("refusing to encrypt a malformed credential");
    return sealEnvelope(JSON.stringify(cred), this.material(this.ring.currentVersion), aad);
  }

  decrypt(envelope: string, aad?: string): Credential {
    const parsed = parseEnvelope(envelope);
    const plain = openEnvelope(envelope, this.material(parsed.keyVersion), aad);
    const value: unknown = JSON.parse(plain);
    if (!isCredential(value)) throw new Error("decrypted payload is not a credential");
    return value;
  }

  /** True when the envelope is sealed under an older key version than the ring's current one. */
  needsRotation(envelope: string): boolean {
    return parseEnvelope(envelope).keyVersion !== this.ring.currentVersion;
  }

  /** Re-seals under the current key version (opening with whichever older version it was sealed with). */
  rotate(envelope: string, aad?: string): string {
    const parsed = parseEnvelope(envelope);
    return rotateEnvelope(envelope, this.material(parsed.keyVersion), this.material(this.ring.currentVersion), aad);
  }
}

/** Constant-time comparison of two refresh tokens (used by stores that dedupe rotations). */
export function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.byteLength === bb.byteLength && timingSafeEqual(ab, bb);
}

/** `CredentialStore` over any `EnvelopeStore`, encrypting with the codec and binding envelopes to the scope via AAD. */
export class EncryptedCredentialStore implements CredentialStore {
  constructor(private readonly envelopes: EnvelopeStore, private readonly codec: EncryptedCredentialCodec) {}

  async load(scope: TenantScope): Promise<Credential | null> {
    assertScope(scope, "EncryptedCredentialStore.load");
    const envelope = await this.envelopes.load(scope);
    if (!envelope) return null;
    return this.codec.decrypt(envelope, scopeAad(scope));
  }

  async save(scope: TenantScope, cred: Credential): Promise<void> {
    assertScope(scope, "EncryptedCredentialStore.save");
    await this.envelopes.save(scope, this.codec.encrypt(cred, scopeAad(scope)));
  }

  async delete(scope: TenantScope): Promise<void> {
    assertScope(scope, "EncryptedCredentialStore.delete");
    await this.envelopes.delete(scope);
  }
}

/** Test/dev envelope store. */
export class InMemoryEnvelopeStore implements EnvelopeStore {
  readonly rows = new Map<string, string>();
  async load(scope: TenantScope): Promise<string | null> {
    return this.rows.get(scopeKey(scope)) ?? null;
  }
  async save(scope: TenantScope, envelope: string): Promise<void> {
    this.rows.set(scopeKey(scope), envelope);
  }
  async delete(scope: TenantScope): Promise<void> {
    this.rows.delete(scopeKey(scope));
  }
}

/** Test/dev credential store. Holds credentials in memory, keyed by scope; optionally encrypted with a codec. */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly plain = new Map<string, Credential>();
  private readonly encrypted: EncryptedCredentialStore | null;
  readonly saves: { scope: TenantScope; at: number }[] = [];

  constructor(codec?: EncryptedCredentialCodec) {
    this.encrypted = codec ? new EncryptedCredentialStore(new InMemoryEnvelopeStore(), codec) : null;
  }

  async load(scope: TenantScope): Promise<Credential | null> {
    if (this.encrypted) return this.encrypted.load(scope);
    const c = this.plain.get(scopeKey(scope));
    return c ? { ...c } : null;
  }

  async save(scope: TenantScope, cred: Credential): Promise<void> {
    if (!isCredential(cred)) throw new Error("refusing to store a malformed credential");
    this.saves.push({ scope, at: Date.now() });
    if (this.encrypted) return this.encrypted.save(scope, cred);
    this.plain.set(scopeKey(scope), { ...cred });
  }

  async delete(scope: TenantScope): Promise<void> {
    if (this.encrypted) return this.encrypted.delete(scope);
    this.plain.delete(scopeKey(scope));
  }
}
