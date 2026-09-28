# Operations runbook

## Deploying

1. Provision PostgreSQL 15+ and create a database and a role with DML rights only for the API (`yzquant_api`) and a migration role with DDL rights.
2. Generate secrets: `openssl rand -base64 32` for `SECRETS_MASTER_KEY` and `SESSION_SECRET`. Store them in the host's secret manager, never in the repo.
3. `npm ci && npm run typecheck && npm test`.
4. `DATABASE_URL=postgres://... npm run db:migrate` (migration role).
5. `npm run bootstrap` to create the two users (or `BOOTSTRAP_USERS='[...]' npm run bootstrap`).
6. Run `apps/api` (`npm run start -w apps/api`) behind TLS with `APP_ORIGIN`/`API_ORIGIN` set to the public HTTPS origins, and serve `apps/web/dist` (`npm run build -w apps/web`) from the same origin or from `APP_ORIGIN`.
7. Each user signs in, enrols MFA (Settings → Security) and connects their Robinhood Agentic account (Settings → Robinhood). The account starts in `research_only` autonomy and paused. Raise the autonomy level deliberately after shadow results are satisfactory.

## Secret rotation

`SECRETS_MASTER_KEY` is versioned. To rotate: set `SECRETS_MASTER_KEY_NEXT`, run `npx tsx scripts/rotate-secrets.ts` (re-encrypts every envelope under the new key), then swap the variables and restart. Session secret rotation simply logs everybody out.

## Daily checks

- System Health page: every component should be Healthy. Warnings on `market_data` mean quotes are aging; Critical means the trading cycle is blocked (no new entries).
- Reconciliation: `lastReconciledAt` must be within the last cycle; a failed reconciliation pauses that account only.
- Learning health: if the learning engine is `frozen`, trading continues on the last validated strategy versions and no adaptation is applied until an operator clears the failure.

## Kill switches

| Scope | Where | Effect |
|---|---|---|
| Account | Risk page → Kill switch | Blocks new entries for that account; risk-reducing exits remain allowed. |
| Global | Admin → Global risk | Blocks new entries for every account; optional `liveExecutionDisabled` blocks every order; `forceShadowMode` routes all approved trades to the simulated path. |

Releasing any kill switch requires step-up authentication and is audited.

## Backups

Back up PostgreSQL nightly. Broker credentials are useless without `SECRETS_MASTER_KEY`, so back up the key separately from the database.

## Incident: positions differ from internal state

1. The account is auto-paused with kill-switch reason `position_mismatch`.
2. Open the Positions page: rows marked `external` exist at Robinhood without an internal trade. Decide whether to adopt them (attach to a strategy) or close them manually in the Robinhood app.
3. Trigger `POST /api/accounts/:id/broker/sync` (Settings → Sync now). When reconciliation passes, release the kill switch.
