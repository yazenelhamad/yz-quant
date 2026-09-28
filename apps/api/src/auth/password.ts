import argon2 from "argon2";

const OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export async function hashPassword(password: string): Promise<string> {
  validatePasswordPolicy(password);
  return argon2.hash(password, OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function validatePasswordPolicy(password: string): void {
  if (password.length < 12) throw new PasswordPolicyError("Password must be at least 12 characters");
  if (password.length > 256) throw new PasswordPolicyError("Password is too long");
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3) throw new PasswordPolicyError("Password must mix at least three of: lowercase, uppercase, digits, symbols");
}

export class PasswordPolicyError extends Error {
  override readonly name = "PasswordPolicyError";
}
