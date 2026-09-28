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

/** Policy is operator-configurable: PASSWORD_MIN_LENGTH (default 6) and PASSWORD_MIN_CLASSES (default 2). */
export function passwordPolicy(): { minLength: number; minClasses: number } {
  const minLength = Math.max(4, Number(process.env["PASSWORD_MIN_LENGTH"] ?? 6) || 6);
  const minClasses = Math.min(4, Math.max(1, Number(process.env["PASSWORD_MIN_CLASSES"] ?? 2) || 2));
  return { minLength, minClasses };
}

export function validatePasswordPolicy(password: string): void {
  const { minLength, minClasses } = passwordPolicy();
  if (password.length < minLength) throw new PasswordPolicyError(`Password must be at least ${minLength} characters`);
  if (password.length > 256) throw new PasswordPolicyError("Password is too long");
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < minClasses) throw new PasswordPolicyError(`Password must mix at least ${minClasses} of: lowercase, uppercase, digits, symbols`);
}

export class PasswordPolicyError extends Error {
  override readonly name = "PasswordPolicyError";
}
