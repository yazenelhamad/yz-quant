import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, id, ts, updatedAt } from "./_common.js";

export const users = pgTable("users", {
  id: id(),
  /** Login name (lower-case). Either username or email must be set. */
  username: text("username"),
  email: text("email"),
  displayName: text("display_name").notNull(),
  role: text("role").$type<"admin" | "trader">().notNull().default("trader"),
  passwordHash: text("password_hash").notNull(),
  /** Encrypted TOTP secret envelope (null = MFA not enrolled). */
  mfaSecretEnc: text("mfa_secret_enc"),
  mfaEnabled: boolean("mfa_enabled").notNull().default(false),
  /** Argon2 hashes of unused recovery codes. */
  mfaRecoveryHashes: jsonb("mfa_recovery_hashes").$type<string[]>().notNull().default([]),
  active: boolean("active").notNull().default(true),
  failedLogins: integer("failed_logins").notNull().default(0),
  lockedUntil: ts("locked_until"),
  passwordChangedAt: ts("password_changed_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("users_email_uq").on(t.email), uniqueIndex("users_username_uq").on(t.username)]);

export const sessions = pgTable("sessions", {
  id: id(), // opaque random id (hash stored, see sessionHash)
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** SHA-256 of the cookie token; the raw token is never stored. */
  tokenHash: text("token_hash").notNull(),
  csrfToken: text("csrf_token").notNull(),
  userAgent: text("user_agent"),
  ip: text("ip"),
  deviceLabel: text("device_label"),
  mfaVerified: boolean("mfa_verified").notNull().default(false),
  /** Last successful step-up (password + MFA) for sensitive actions. */
  stepUpAt: ts("step_up_at"),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
  revokedReason: text("revoked_reason"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("sessions_token_hash_uq").on(t.tokenHash), index("sessions_user_idx").on(t.userId)]);

export const loginAttempts = pgTable("login_attempts", {
  id: id(),
  email: text("email").notNull(),
  ip: text("ip"),
  success: boolean("success").notNull(),
  reason: text("reason"),
  at: ts("at").notNull().defaultNow(),
}, (t) => [index("login_attempts_email_idx").on(t.email, t.at)]);
