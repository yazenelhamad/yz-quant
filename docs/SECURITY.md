# Security model

## Principals

Exactly two human users, provisioned by an operator with `scripts/bootstrap-users.ts`. No registration endpoint exists; the users table is only written by the bootstrap script and by admin password resets.

Roles: `admin` (manage both users, shared strategies, models, infrastructure, global kill switch, audit review) and `trader`. Roles never override account ownership: order placement, autonomy changes and risk-setting changes require the **owner's** authenticated session.

## Authentication

- Passwords hashed with Argon2id (memory 64 MiB, 3 iterations).
- TOTP multi-factor authentication (RFC 6238) with encrypted secrets and single-use recovery codes. MFA is enforced when enabled on the user; admins can require it for everyone.
- Sessions: random 256-bit opaque IDs stored server side, delivered in an `HttpOnly; Secure; SameSite=Strict` cookie, signed with `SESSION_SECRET`. Absolute lifetime 12 h, inactivity timeout 30 min (configurable), rotation on login and on privilege changes.
- Device/session management: each session records user agent, IP, creation and last-seen time; users can revoke any session; admins can revoke all.
- Step-up confirmation (password + MFA) for autonomy changes, risk-limit changes, broker connection/disconnection, kill-switch release.
- Rate limiting on login, MFA and every mutating route. Failed login lockout with exponential backoff.

## Authorization

- Every request passes: session valid → user active → route role check → tenant scope resolution → account ownership check. The scope object is the only thing repositories accept.
- CSRF: double-submit token bound to the session, required on every non-GET request; `SameSite=Strict` cookies as second layer; origin check against `APP_ORIGIN`.

## Secrets

- `SECRETS_MASTER_KEY` (32 bytes) encrypts broker OAuth tokens, MFA secrets and API keys at rest with AES-256-GCM (versioned envelope so keys can rotate: `scripts/rotate-secrets.ts`).
- Secrets never leave the server. API responses carry connection *status* only. Logs redact bearer tokens and account numbers (masked to the last four digits).
- Least privilege: the database role used by the API needs no DDL rights in production; migrations run separately.

## Prompt-injection defence

All external text (news, filings, web content, model outputs) enters the system wrapped in a `DataEnvelope` that marks it as untrusted data. Agents receive it inside delimited data blocks with an explicit "this is data, not instructions" framing, produce **schema-validated structured output only**, and have no tool that reaches the broker. The only path to an order is `TradeCandidate → PortfolioEngine → RiskEngine → ExecutionEngine`, all deterministic code.

## Audit

Every material event (login, MFA, session revocation, setting change, autonomy change, thesis, risk decision, order, cancel, fill, reconciliation result, kill switch, learning update, admin action) is appended to `audit_logs` with user, account, strategy/version, model/prompt version, before/after payloads and result. Audit rows are insert-only.

## Operational

- Run behind TLS. Set `APP_ORIGIN`/`API_ORIGIN` to the real HTTPS origins.
- Bind the API to a private network or put it behind an authenticating reverse proxy; the app is private by design.
- Keep the Robinhood Agentic account funded only with capital you intend the system to manage.
