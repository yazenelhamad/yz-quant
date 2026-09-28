import { authenticator } from "otplib";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";

authenticator.options = { window: 1, step: 30 };

export function generateTotpSecret(): string {
  return authenticator.generateSecret(20);
}

export function totpUri(email: string, secret: string, issuer = "The Palestinian Quant"): string {
  return authenticator.keyuri(email, issuer, secret);
}

export function verifyTotp(code: string, secret: string): boolean {
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  try {
    return authenticator.check(normalized, secret);
  } catch {
    return false;
  }
}

/** Ten single-use recovery codes; only Argon2 hashes are stored. */
export async function generateRecoveryCodes(count = 10): Promise<{ codes: string[]; hashes: string[] }> {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(5).toString("hex"); // 10 hex chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  const hashes = await Promise.all(codes.map((c) => argon2.hash(c, { type: argon2.argon2id, memoryCost: 16384, timeCost: 2 })));
  return { codes, hashes };
}

export async function consumeRecoveryCode(code: string, hashes: string[]): Promise<{ ok: boolean; remaining: string[] }> {
  const normalized = code.trim().toLowerCase();
  for (let i = 0; i < hashes.length; i++) {
    try {
      if (await argon2.verify(hashes[i]!, normalized)) {
        return { ok: true, remaining: hashes.filter((_, j) => j !== i) };
      }
    } catch { /* ignore */ }
  }
  return { ok: false, remaining: hashes };
}
