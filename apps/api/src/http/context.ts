import type { FastifyReply, FastifyRequest } from "fastify";
import type { TenantScope, UserRole } from "@yz/core";
import type { BrokerAccountRow, BrokerAccountsRepository, SessionRow, UserRow } from "@yz/db";
import type { SessionService } from "../auth/sessions.js";
import { forbidden, notFound, stepUpRequired, unauthorized } from "./errors.js";

export const SESSION_COOKIE = "yz_session";

export interface RequestAuth {
  user: UserRow;
  session: SessionRow;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: RequestAuth;
  }
}

export interface Guards {
  /** Populates request.auth or throws 401. Requires MFA verified when the user has MFA enabled. */
  requireAuth(req: FastifyRequest): RequestAuth;
  requireRole(req: FastifyRequest, role: UserRole): RequestAuth;
  requireStepUp(req: FastifyRequest): RequestAuth;
  /**
   * Resolve the tenant scope for an account id in the URL.
   * - owner: always allowed
   * - admin: allowed for read-only access when `mode === "read"`; writes are refused
   * Returns the account row too, so callers never re-fetch it un-scoped.
   */
  resolveScope(req: FastifyRequest, accountId: string, mode: "read" | "write"): Promise<{ scope: TenantScope; account: BrokerAccountRow; actingAsAdmin: boolean }>;
}

export function buildGuards(deps: { sessions: SessionService; accounts: BrokerAccountsRepository }): Guards {
  const requireAuth = (req: FastifyRequest): RequestAuth => {
    if (!req.auth) throw unauthorized();
    if (req.auth.user.mfaEnabled && !req.auth.session.mfaVerified) throw unauthorized("MFA verification required");
    if (!req.auth.user.active) throw unauthorized("User is disabled");
    return req.auth;
  };
  return {
    requireAuth,
    requireRole(req, role) {
      const auth = requireAuth(req);
      if (role === "admin" && auth.user.role !== "admin") throw forbidden("Admin role required");
      return auth;
    },
    requireStepUp(req) {
      const auth = requireAuth(req);
      if (!deps.sessions.stepUpValid(auth.session)) throw stepUpRequired();
      return auth;
    },
    async resolveScope(req, accountId, mode) {
      const auth = requireAuth(req);
      if (!accountId || typeof accountId !== "string") throw notFound("Account not found");
      const owned = await deps.accounts.forScope({ userId: auth.user.id, brokerAccountId: accountId });
      if (owned) {
        return { scope: { userId: auth.user.id, brokerAccountId: owned.id }, account: owned, actingAsAdmin: false };
      }
      if (auth.user.role === "admin" && mode === "read") {
        const any = await deps.accounts.byId(accountId);
        if (!any) throw notFound("Account not found");
        return { scope: { userId: any.userId, brokerAccountId: any.id }, account: any, actingAsAdmin: true };
      }
      // Traders (and admins on writes) get the same answer whether the account is missing or foreign.
      throw forbidden("You do not have access to this account");
    },
  };
}

export function clientIp(req: FastifyRequest): string | null {
  return req.ip ?? null;
}

export function setSessionCookie(reply: FastifyReply, value: string, secure: boolean, maxAgeSeconds: number): void {
  reply.setCookie(SESSION_COOKIE, value, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure, sameSite: "strict", path: "/" });
}
