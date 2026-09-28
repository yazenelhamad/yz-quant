import type { FastifyInstance } from "fastify";
import { z } from "zod";
import QRCode from "qrcode";
import type { AppContext } from "../http/app.js";
import { clearSessionCookie, setSessionCookie, SESSION_COOKIE } from "../http/context.js";
import { HttpError, locked, unauthorized, validation } from "../http/errors.js";
import { hashPassword, PasswordPolicyError, verifyPassword } from "./password.js";
import { consumeRecoveryCode, generateRecoveryCodes, generateTotpSecret, totpUri, verifyTotp } from "./totp.js";

const LoginSchema = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(256) });
const CodeSchema = z.object({ code: z.string().min(6).max(64) });
const StepUpSchema = z.object({ password: z.string().min(1).max(256), code: z.string().max(64).optional() });
const PasswordChangeSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) });

const LOCKOUT_WINDOW_MIN = 15;
const LOCKOUT_THRESHOLD = 5;

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos, sessions, guards, audit, env, secretBox } = ctx;
  const secure = env.NODE_ENV === "production";
  const cookieMaxAge = env.SESSION_ABSOLUTE_HOURS * 3600;
  const strictLimit = { config: { rateLimit: { max: env.AUTH_RATE_LIMIT_MAX, timeWindow: "1 minute" } } };

  app.post("/api/auth/login", strictLimit, async (req, reply) => {
    const body = LoginSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid login payload");
    const { email, password } = body.data;
    const ip = req.ip ?? null;
    const user = await repos.users.byEmail(email);
    const since = new Date(Date.now() - LOCKOUT_WINDOW_MIN * 60_000).toISOString();
    const failures = await repos.loginAttempts.recentFailures(email, since);
    if (failures >= LOCKOUT_THRESHOLD || (user?.lockedUntil && new Date(user.lockedUntil) > new Date())) {
      await repos.loginAttempts.record(email, ip, false, "locked");
      await audit.record({ category: "auth", action: "login", result: "rejected", userId: user?.id ?? null, detail: { email, reason: "locked" }, ip });
      throw locked("Too many failed attempts. Try again later.");
    }
    const ok = user ? await verifyPassword(user.passwordHash, password) : (await verifyPassword("$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", password), false);
    if (!user || !ok || !user.active) {
      await repos.loginAttempts.record(email, ip, false, !user ? "unknown_user" : !user.active ? "disabled" : "bad_password");
      if (user) await repos.users.update(user.id, { failedLogins: user.failedLogins + 1, lockedUntil: user.failedLogins + 1 >= LOCKOUT_THRESHOLD ? new Date(Date.now() + LOCKOUT_WINDOW_MIN * 60_000).toISOString() : null });
      await audit.record({ category: "auth", action: "login", result: "rejected", userId: user?.id ?? null, detail: { email }, ip });
      throw unauthorized("Invalid email or password");
    }
    await repos.loginAttempts.record(email, ip, true, null);
    await repos.users.update(user.id, { failedLogins: 0, lockedUntil: null });
    const issued = await sessions.issue({ userId: user.id, userAgent: req.headers["user-agent"] ?? null, ip, mfaVerified: !user.mfaEnabled });
    setSessionCookie(reply, issued.cookieValue, secure, cookieMaxAge);
    await audit.record({ category: "auth", action: "login", result: "ok", userId: user.id, sessionId: issued.row.id, detail: { mfaRequired: user.mfaEnabled }, ip });
    return { ok: true, mfaRequired: user.mfaEnabled };
  });

  app.post("/api/auth/mfa/verify", strictLimit, async (req, reply) => {
    if (!req.auth) throw unauthorized();
    const { user, session } = req.auth;
    const body = CodeSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid code");
    if (!user.mfaEnabled || !user.mfaSecretEnc) throw validation("MFA is not enabled for this user");
    const secret = secretBox.open(user.mfaSecretEnc, user.id);
    let ok = verifyTotp(body.data.code, secret);
    if (!ok) {
      const rc = await consumeRecoveryCode(body.data.code, user.mfaRecoveryHashes);
      if (rc.ok) {
        ok = true;
        await repos.users.update(user.id, { mfaRecoveryHashes: rc.remaining });
        await audit.record({ category: "auth", action: "mfa_recovery_code_used", result: "ok" }, req);
      }
    }
    if (!ok) {
      await audit.record({ category: "auth", action: "mfa_verify", result: "rejected" }, req);
      throw unauthorized("Invalid MFA code");
    }
    const rotated = await sessions.rotate(session, { userAgent: req.headers["user-agent"] ?? null, ip: req.ip ?? null, mfaVerified: true });
    setSessionCookie(reply, rotated.cookieValue, secure, cookieMaxAge);
    await audit.record({ category: "auth", action: "mfa_verify", result: "ok", sessionId: rotated.row.id }, req);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.auth) {
      await repos.sessions.revoke(req.auth.session.id, "logout");
      await audit.record({ category: "auth", action: "logout", result: "ok" }, req);
    }
    clearSessionCookie(reply, secure);
    return { ok: true };
  });

  app.get("/api/auth/session", async (req) => {
    if (!req.auth) throw unauthorized();
    const { user, session } = req.auth;
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role, mfaEnabled: user.mfaEnabled },
      mfaVerified: session.mfaVerified,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      inactivityTimeoutSeconds: sessions.inactivityTimeoutSeconds,
      stepUpValidUntil: sessions.stepUpValidUntil(session),
    };
  });

  app.post("/api/auth/step-up", strictLimit, async (req) => {
    const { user, session } = guards.requireAuth(req);
    const body = StepUpSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid payload");
    const ok = await verifyPassword(user.passwordHash, body.data.password);
    let mfaOk = !user.mfaEnabled;
    if (user.mfaEnabled && user.mfaSecretEnc) {
      mfaOk = !!body.data.code && verifyTotp(body.data.code, secretBox.open(user.mfaSecretEnc, user.id));
    }
    if (!ok || !mfaOk) {
      await audit.record({ category: "auth", action: "step_up", result: "rejected" }, req);
      throw unauthorized(user.mfaEnabled ? "Invalid password or MFA code" : "Invalid password");
    }
    await sessions.markStepUp(session);
    await audit.record({ category: "auth", action: "step_up", result: "ok" }, req);
    const refreshed = await repos.sessions.byId(session.id);
    return { ok: true, validUntil: refreshed ? sessions.stepUpValidUntil(refreshed) : null };
  });

  app.post("/api/auth/mfa/enroll", async (req) => {
    const { user, session } = guards.requireStepUp(req);
    const secret = generateTotpSecret();
    // Stored encrypted but not enabled until confirmed.
    await repos.users.update(user.id, { mfaSecretEnc: secretBox.seal(secret, user.id), mfaEnabled: false });
    const otpauthUrl = totpUri(user.email, secret);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
    await audit.record({ category: "auth", action: "mfa_enroll_started", result: "ok", sessionId: session.id }, req);
    return { secret, otpauthUrl, qrDataUrl };
  });

  app.post("/api/auth/mfa/confirm", strictLimit, async (req, reply) => {
    const { user, session } = guards.requireStepUp(req);
    const body = CodeSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid code");
    if (!user.mfaSecretEnc) throw validation("Start enrollment first");
    if (!verifyTotp(body.data.code, secretBox.open(user.mfaSecretEnc, user.id))) throw unauthorized("Invalid MFA code");
    const { codes, hashes } = await generateRecoveryCodes();
    await repos.users.update(user.id, { mfaEnabled: true, mfaRecoveryHashes: hashes });
    const rotated = await sessions.rotate(session, { userAgent: req.headers["user-agent"] ?? null, ip: req.ip ?? null, mfaVerified: true });
    await repos.sessions.revokeAllForUser(user.id, "mfa_enabled", rotated.row.id);
    setSessionCookie(reply, rotated.cookieValue, secure, cookieMaxAge);
    await audit.record({ category: "auth", action: "mfa_enabled", result: "ok", sessionId: rotated.row.id }, req);
    return { ok: true, recoveryCodes: codes };
  });

  app.post("/api/auth/mfa/disable", strictLimit, async (req) => {
    const { user } = guards.requireStepUp(req);
    const body = CodeSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid code");
    if (!user.mfaEnabled || !user.mfaSecretEnc) throw validation("MFA is not enabled");
    if (!verifyTotp(body.data.code, secretBox.open(user.mfaSecretEnc, user.id))) throw unauthorized("Invalid MFA code");
    await repos.users.update(user.id, { mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryHashes: [] });
    await audit.record({ category: "auth", action: "mfa_disabled", result: "ok" }, req);
    return { ok: true };
  });

  app.post("/api/auth/password", strictLimit, async (req, reply) => {
    const { user, session } = guards.requireStepUp(req);
    const body = PasswordChangeSchema.safeParse(req.body);
    if (!body.success) throw validation("Invalid payload");
    if (!(await verifyPassword(user.passwordHash, body.data.currentPassword))) throw unauthorized("Current password is incorrect");
    let hash: string;
    try {
      hash = await hashPassword(body.data.newPassword);
    } catch (e) {
      if (e instanceof PasswordPolicyError) throw validation(e.message);
      throw e;
    }
    await repos.users.update(user.id, { passwordHash: hash, passwordChangedAt: new Date().toISOString() });
    const rotated = await sessions.rotate(session, { userAgent: req.headers["user-agent"] ?? null, ip: req.ip ?? null, mfaVerified: session.mfaVerified });
    await repos.sessions.revokeAllForUser(user.id, "password_changed", rotated.row.id);
    setSessionCookie(reply, rotated.cookieValue, secure, cookieMaxAge);
    await audit.record({ category: "auth", action: "password_changed", result: "ok", sessionId: rotated.row.id }, req);
    return { ok: true };
  });

  app.get("/api/auth/sessions", async (req) => {
    const { user, session } = guards.requireAuth(req);
    const rows = await repos.sessions.activeForUser(user.id);
    return { sessions: rows.map((s) => ({ id: s.id, deviceLabel: s.deviceLabel, userAgent: s.userAgent, ip: s.ip, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === session.id })) };
  });

  app.delete("/api/auth/sessions/:id", async (req) => {
    const { user } = guards.requireAuth(req);
    const id = (req.params as { id: string }).id;
    const target = await repos.sessions.byId(id);
    if (!target || target.userId !== user.id) throw new HttpError(404, "not_found", "Session not found");
    await repos.sessions.revoke(id, "user_revoked");
    await audit.record({ category: "session", action: "revoke", result: "ok", detail: { sessionId: id } }, req);
    return { ok: true };
  });

  app.delete("/api/auth/sessions", async (req) => {
    const { user, session } = guards.requireAuth(req);
    const revoked = await repos.sessions.revokeAllForUser(user.id, "user_revoked_all", session.id);
    await audit.record({ category: "session", action: "revoke_all", result: "ok", detail: { revoked } }, req);
    return { ok: true, revoked };
  });

  // Expose cookie name for tests
  void SESSION_COOKIE;
}
