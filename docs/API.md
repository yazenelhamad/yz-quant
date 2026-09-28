# HTTP API contract

Base URL: `API_ORIGIN` (default `http://localhost:8787`). All routes are under `/api`. JSON in/out. Times are ISO-8601 UTC. Money is USD numbers. Account numbers are always masked (`••••1234`).

Authentication: opaque session cookie `yz_session` (HttpOnly, Secure in production, SameSite=Strict). Every non-GET request must send header `x-csrf-token` equal to the `csrfToken` returned by `/api/auth/session`. Errors are `{ error: { code: string, message: string, detail?: unknown } }` with proper status codes (401 unauthenticated, 403 forbidden / wrong account, 409 conflict, 422 validation, 423 locked, 428 step-up required, 429 rate limited, 503 dependency unavailable).

Account scoping: routes under `/api/accounts/:accountId/...` resolve a `TenantScope` = (session user, accountId). If the account is not owned by the session user the API answers 403 for traders. Admins may read (`GET`) any account for the comparison view but every write on someone else's account is refused (403) except the admin controls listed under `/api/admin`.

Step-up: routes marked **(step-up)** require a recent (≤10 min) password (+ MFA when enrolled) confirmation via `POST /api/auth/step-up`; otherwise 428.

## Auth

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/auth/login` | `{email, password}` | `{ok: true, mfaRequired: boolean}` — when MFA is required the session is created in a pre-MFA state; `/api/auth/mfa/verify` must follow. |
| POST | `/api/auth/mfa/verify` | `{code}` (TOTP or recovery code) | `{ok: true}` |
| POST | `/api/auth/logout` | | `{ok: true}` |
| GET | `/api/auth/session` | | `{user: {id, email, displayName, role, mfaEnabled}, csrfToken, expiresAt, inactivityTimeoutSeconds, stepUpValidUntil: string|null}` |
| POST | `/api/auth/step-up` | `{password, code?}` | `{ok: true, validUntil}` |
| POST | `/api/auth/mfa/enroll` **(step-up)** | | `{secret, otpauthUrl, qrDataUrl}` (not enabled until confirmed) |
| POST | `/api/auth/mfa/confirm` **(step-up)** | `{code}` | `{ok: true, recoveryCodes: string[]}` (shown once) |
| POST | `/api/auth/mfa/disable` **(step-up)** | `{code}` | `{ok: true}` |
| POST | `/api/auth/password` **(step-up)** | `{currentPassword, newPassword}` | `{ok: true}` (revokes other sessions) |
| GET | `/api/auth/sessions` | | `{sessions: [{id, deviceLabel, userAgent, ip, createdAt, lastSeenAt, current: boolean}]}` |
| DELETE | `/api/auth/sessions/:id` | | `{ok: true}` |
| DELETE | `/api/auth/sessions` | | `{ok: true, revoked: number}` (all other sessions) |

No signup route exists. Users are provisioned with `npm run bootstrap`.

## Accounts (header selector)

| Method | Path | Response |
|---|---|---|
| GET | `/api/accounts` | `{accounts: [AccountSummary]}` — for the session user (admins additionally get `allAccounts` with owner info for read-only comparison) |
| GET | `/api/accounts/:accountId` | `AccountSummary` |
| POST | `/api/accounts` **(step-up)** | `{kind: "robinhood_agentic"|"simulated", label}` → `AccountSummary` (simulated accounts are for shadow research only and are always labelled SIMULATED) |
| POST | `/api/accounts/:accountId/autonomy` **(step-up)** | `{level: AutonomyLevel}` → `AccountSummary` |
| POST | `/api/accounts/:accountId/pause` | `{paused: boolean, reason?}` → `AccountSummary` (pausing needs no step-up; resuming does) |
| GET | `/api/accounts/:accountId/risk-settings` | `RiskSettings` |
| PUT | `/api/accounts/:accountId/risk-settings` **(step-up)** | `RiskSettings` → `RiskSettings` |
| GET | `/api/accounts/:accountId/kill-switch` | `{active, reasons, allowRiskReducingExits, triggeredAt, triggeredBy, note}` |
| POST | `/api/accounts/:accountId/kill-switch` | `{active: true, note?}` (trigger manual) / `{active: false}` **(step-up)** (release) |

`AccountSummary = { id, kind, label, accountNumberMasked, agenticAllowed, accountType, optionsEnabledAtBroker, status, statusDetail, lastHealthyAt, lastReconciledAt, reconciliationOk, autonomyLevel, tradingPaused, pausedReason, portfolio: {asOf, totalValue, cash, buyingPower, equityValue, dailyPnl, totalPnl, drawdownPct, exposurePct} | null, killSwitchActive, owner: {id, displayName} }`

## Robinhood connection

| Method | Path | Response |
|---|---|---|
| GET | `/api/accounts/:accountId/broker/status` | `{status, detail, lastHealthyAt, consecutiveFailures, tools: string[] | null, agenticAccountNumberMasked}` |
| POST | `/api/accounts/:accountId/broker/connect` **(step-up)** | `{authorizationUrl}` — the user opens it, logs in at robinhood.com, and is redirected back |
| GET | `/api/broker/oauth/callback?code&state` | HTML page that completes the flow (state bound to user+account), then redirects to `APP_ORIGIN/settings?connected=1` |
| POST | `/api/accounts/:accountId/broker/disconnect` **(step-up)** | `{ok: true}` (credential deleted, account paused) |
| POST | `/api/accounts/:accountId/broker/sync` | `{portfolio, positions: number, orders: number, reconciliation}` |

## Overview & dashboards (all scoped)

| Path | Response |
|---|---|
| GET `/api/accounts/:accountId/overview` | `{account: AccountSummary, portfolio, pnl: {daily, total, dailyPct, totalPct}, positionsCount, exposure: {grossPct, bySector: Record<string, number>, beta}, regime: RegimeAssessment|null, drawdownPct, risk: {utilization: Record<string, {used, limit}>, capacity}, activeStrategies: [{id, key, name, stage, allocation}], topOpportunities: Opportunity[], upcomingCatalysts: [{symbol, kind, at, description}], alerts: Alert[], executionIssues: [{orderId, symbol, issue, at}], broker: {status, detail}, dataQuality: {quotes, bars, regime}}` |
| GET `/api/accounts/:accountId/opportunities` | `{opportunities: Opportunity[]}` where `Opportunity = {candidateId, symbol, strategyKey, strategyName, expectedEdge, confidence, calibratedConfidence, potentialDownsidePct, holdingPeriodDays, regimeFit, liquidityScore, catalyst, risk: {score, notes}, portfolioFit, historicalSimilarity, strategyPerformance, variantScore, finalStatus, reasons: string[], createdAt}` (portfolio fit computed for THIS account) |
| GET `/api/accounts/:accountId/positions` | `{positions: PositionView[]}` with `PositionView = {symbol, quantity, sharesAvailableForSells, averageCost, markPrice, marketValue, unrealizedPnl, unrealizedPnlPct, strategyKey, tradeId, thesisId, entryReason, initialConfidence, currentConfidence, regimeAtEntry, currentRegime, expectedHoldingDays, ageDays, invalidationPrice, invalidationCondition, targetPrice, exitLogic, riskContribution, external: boolean, dataFreshness}` |
| GET `/api/accounts/:accountId/positions/:symbol` | `PositionView & {thesis: TradeThesis|null, thesisHistory: [...], modelVotes, news: [...], reasonsToHold: string[], reasonsToExit: string[], similarTrades: HistoricalAnalog[], orders: Order[]}` |
| POST `/api/accounts/:accountId/positions/:symbol/close` | `{reason}` → `{tradeId, orderId}` — human-initiated exit; goes through risk engine (exit path) and execution engine; refused when broker not connected |
| GET `/api/accounts/:accountId/trades?state=&mode=&limit=` | `{trades: TradeView[]}` |
| GET `/api/accounts/:accountId/trades/:tradeId` | `{trade, thesis, events, orders, fills, riskDecisions, review, lessons, explanation: string}` |
| GET `/api/accounts/:accountId/orders?limit=` | `{orders: Order[]}` (every Robinhood action) |
| POST `/api/accounts/:accountId/orders/:orderId/cancel` | → `{accepted}` |
| GET `/api/accounts/:accountId/rejections?limit=` | `{rejections: RejectedTrade[]}` |
| GET `/api/accounts/:accountId/decisions?limit=` | `{decisions: RiskDecision[], fastBrain: [...]}` |
| GET `/api/accounts/:accountId/approvals` | `{approvals: [...]}` ; POST `/api/accounts/:accountId/approvals/:id` `{decision: "approve"|"decline"}` |
| GET `/api/accounts/:accountId/strategies` | `{strategies: [{id, key, name, family, description, visibility, globalStage, globallyDisabled, settings: UserStrategySettings, scorecard: StrategyScorecard|null}]}` |
| PUT `/api/accounts/:accountId/strategies/:strategyId/settings` | `UserStrategySettings` (stage cannot exceed global stage; enabling live requires step-up) |
| GET `/api/accounts/:accountId/risk` | `{settings, utilization, killSwitch, global: {liveExecutionDisabled, forceShadowMode, pausedByAdmin}, recentDecisions, alerts}` |
| GET `/api/accounts/:accountId/analytics?period=` | `{performance: PerformanceStats, byStrategy, equityCurve: [{time, value}], drawdownCurve, exposureHistory, realizedPnlFromBroker}` |
| GET `/api/accounts/:accountId/journal?limit=` | `{entries: [{tradeId, symbol, strategyKey, openedAt, closedAt, returnPct, classification, thesisSummary, lesson}]}` |
| GET `/api/accounts/:accountId/learning` | account-specific learning view (same shape as `/api/learning` filtered to this account) |

## Shared intelligence (authenticated, not account-scoped)

| Path | Response |
|---|---|
| GET `/api/market/regime` | `{current: RegimeAssessment|null, history: [...], usefulness: {...}}` |
| GET `/api/market/quotes?symbols=` | `{quotes: Quote[]}` with provenance/freshness |
| GET `/api/strategies` | shared library with global stage, versions, system-wide scorecards |
| GET `/api/strategies/:id` | `{strategy, versions: StrategyVersion[], scorecards: {system, byAccount (only accounts visible to caller)}, profile: StrategyIntelligenceProfile|null}` |
| GET `/api/research/experiments` / POST (admin) | experiments list / create |
| GET `/api/backtests?strategyKey=` / GET `/api/backtests/:id` / POST `/api/backtests` `{strategyKey, versionId?, symbols, start, end, kind}` | run (queued; result id) |
| GET `/api/learning` | `LearningView = {today: Digest|null, week: Digest|null, strategiesImproving, strategiesDeteriorating, signalsImproving, signalsDeteriorating, calibration: CalibrationProfile[], models: ModelIntelligenceProfile[], agents: AgentIntelligenceProfile[], recentLessons, repeatedMistakes, missedOpportunities, regimeInsights, executionInsights, adaptationProposals, learningHealth: {status, lastRunAt, frozen: boolean, reason}}` |
| GET `/api/variant/:ticker` | latest VariantView, consensus snapshot, catalysts, expectations records, company profile |
| POST `/api/variant/:ticker/run` | queue a variant-perception run (returns 503 with `AI models not configured` when applicable) |

## System & admin

| Path | Response |
|---|---|
| GET `/api/system/health` | `{overall: HealthStatus, components: HealthComponent[]}` |
| GET `/api/system/events?limit=` | system events (admin) |
| GET `/api/audit?userId=&accountId=&category=&limit=` | audit logs (admin sees all; traders see their own) |
| GET `/api/admin/comparison` (admin) | `{accounts: [{owner, account: AccountSummary, dailyPnl, totalReturnPct, drawdownPct, exposurePct, riskUtilization, activeStrategies: number, positions: number}]}` — informational only, never merges portfolios |
| GET/PUT `/api/admin/global-risk` (admin, step-up on PUT) | `GlobalRiskState` (`pausedUsers`, `liveExecutionDisabled`, `forceShadowMode`, `disabledStrategyIds`, `globalKillSwitch`) |
| POST `/api/admin/strategies/:id/stage` (admin, step-up) | `{stage, reason}` |
| GET/PUT `/api/admin/models` (admin) | model registry & routing weights |
| GET/PUT `/api/admin/agents` (admin) | agent registry & influence weights |
| GET `/api/admin/users` (admin) | users, sessions count, MFA status; POST `/api/admin/users/:id/sessions/revoke`; POST `/api/admin/users/:id/mfa/reset` (step-up) |
| GET `/api/admin/jobs` (admin) | recent job runs |
