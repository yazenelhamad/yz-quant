import { createHash, createHmac, randomBytes } from "node:crypto";
import type { SessionsRepository, SessionRow } from "@yz/db";
import { constantTimeEqual } from "../security/secrets.js";

export interface SessionConfig {
  secret: string;
  absoluteHours: number;
  inactivityMinutes: number;
  stepUpMinutes: number;
}

export interface IssuedSession {
  /** Value to put in the cookie: <sessionId>.<token>.<signature> */
  cookieValue: string;
  row: SessionRow;
}

export class SessionService {
  constructor(private readonly repo: SessionsRepository, private readonly cfg: SessionConfig) {}

  private sign(payload: string): string {
    return createHmac("sha256", this.cfg.secret).update(payload).digest("base64url");
  }
  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  async issue(input: { userId: string; userAgent: string | null; ip: string | null; mfaVerified: boolean }): Promise<IssuedSession> {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.cfg.absoluteHours * 3600_000).toISOString();
    const row = await this.repo.create({
      userId: input.userId,
      tokenHash: this.hashToken(token),
      csrfToken,
      userAgent: input.userAgent,
      ip: input.ip,
      deviceLabel: deviceLabelFrom(input.userAgent),
      mfaVerified: input.mfaVerified,
      expiresAt,
    });
    const payload = `${row.id}.${token}`;
    return { cookieValue: `${payload}.${this.sign(payload)}`, row };
  }

  /**
   * Validate a cookie. Returns the session row when valid, otherwise a reason.
   * Enforces signature, revocation, absolute expiry and inactivity timeout.
   */
  async validate(cookieValue: string | undefined, now = new Date()): Promise<{ ok: true; session: SessionRow } | { ok: false; reason: "missing" | "malformed" | "bad_signature" | "unknown" | "revoked" | "expired" | "inactive" }> {
    if (!cookieValue) return { ok: false, reason: "missing" };
    const parts = cookieValue.split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed" };
    const [id, token, sig] = parts as [string, string, string];
    if (!constantTimeEqual(sig, this.sign(`${id}.${token}`))) return { ok: false, reason: "bad_signature" };
    const row = await this.repo.byId(id);
    if (!row) return { ok: false, reason: "unknown" };
    if (!constantTimeEqual(row.tokenHash, this.hashToken(token))) return { ok: false, reason: "bad_signature" };
    if (row.revokedAt) return { ok: false, reason: "revoked" };
    if (new Date(row.expiresAt).getTime() <= now.getTime()) {
      await this.repo.revoke(row.id, "expired");
      return { ok: false, reason: "expired" };
    }
    const idleMs = now.getTime() - new Date(row.lastSeenAt).getTime();
    if (idleMs > this.cfg.inactivityMinutes * 60_000) {
      await this.repo.revoke(row.id, "inactivity");
      return { ok: false, reason: "inactive" };
    }
    return { ok: true, session: row };
  }

  async touch(session: SessionRow, now = new Date()): Promise<void> {
    // Avoid a write on every request: only persist if more than 30s elapsed.
    if (now.getTime() - new Date(session.lastSeenAt).getTime() > 30_000) {
      await this.repo.touch(session.id, now.toISOString());
    }
  }

  /** Rotate the session after privilege changes (login, MFA, password change). */
  async rotate(session: SessionRow, input: { userAgent: string | null; ip: string | null; mfaVerified: boolean }): Promise<IssuedSession> {
    await this.repo.revoke(session.id, "rotated");
    return this.issue({ userId: session.userId, ...input });
  }

  stepUpValid(session: SessionRow, now = new Date()): boolean {
    if (!session.stepUpAt) return false;
    return now.getTime() - new Date(session.stepUpAt).getTime() <= this.cfg.stepUpMinutes * 60_000;
  }

  stepUpValidUntil(session: SessionRow): string | null {
    if (!session.stepUpAt) return null;
    return new Date(new Date(session.stepUpAt).getTime() + this.cfg.stepUpMinutes * 60_000).toISOString();
  }

  async markStepUp(session: SessionRow, at = new Date()): Promise<void> {
    await this.repo.update(session.id, { stepUpAt: at.toISOString() });
  }

  async markMfaVerified(session: SessionRow): Promise<void> {
    await this.repo.update(session.id, { mfaVerified: true, stepUpAt: new Date().toISOString() });
  }

  get inactivityTimeoutSeconds(): number {
    return this.cfg.inactivityMinutes * 60;
  }
}

export function deviceLabelFrom(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const os = /Windows/.test(userAgent) ? "Windows" : /Mac OS X/.test(userAgent) ? "macOS" : /iPhone|iPad/.test(userAgent) ? "iOS" : /Android/.test(userAgent) ? "Android" : /Linux/.test(userAgent) ? "Linux" : "Unknown OS";
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Chrome\//.test(userAgent) ? "Chrome" : /Firefox\//.test(userAgent) ? "Firefox" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  return `${browser} on ${os}`;
}
