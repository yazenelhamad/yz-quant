# Architecture

The Palestinian Quant is a private, two-user autonomous trading intelligence platform. It is organised like a small investment firm running two separately managed accounts: one shared research and intelligence stack, two fully isolated trading environments.

```
                         ┌────────────────────── shared ──────────────────────┐
 market data ──► feature engine ──► regime engine ──► strategy library ──► signal ensemble
        │                                  │                 │                    │
        │                          slow brain agents   research lab / backtests   │
        │                          variant perception  learning engine (profiles) │
        └────────────────────────────────────────────────────────────────────────┘
                                             │  trade candidates (user-agnostic)
             ┌───────────────────────────────┴───────────────────────────────┐
             ▼                                                               ▼
   ┌── User A environment ──┐                                      ┌── User B environment ──┐
   │ portfolio engine A     │                                      │ portfolio engine B     │
   │ risk engine A (veto)   │                                      │ risk engine B (veto)   │
   │ fast brain (bounded)   │                                      │ fast brain (bounded)   │
   │ execution engine A     │                                      │ execution engine B     │
   │ broker adapter A ──► Robinhood Agentic account A              │ broker adapter B ──► Robinhood Agentic account B
   └────────────────────────┘                                      └────────────────────────┘
```

The decision hierarchy is fixed and enforced in code, not by convention:

```
AI proposes ─► portfolio engine evaluates ─► risk engine approves (deterministic, absolute veto) ─► execution engine executes ─► broker adapter (scoped to one account)
```

## Repository layout

| Path | Package | Responsibility |
|---|---|---|
| `packages/core` | `@yz/core` | Pure domain logic, no I/O. Types, risk engine, portfolio engine, position sizing, trade lifecycle, feature engine, regime engine, strategy framework and library, signal ensemble, fast brain, execution intelligence, backtesting engine, learning engine, variant perception engine, safe adaptation, versioning. 100% unit-testable. |
| `packages/db` | `@yz/db` | Drizzle ORM schema (PostgreSQL), migrations, tenant-scoped repositories. Runs on PostgreSQL in production and on PGlite (embedded Postgres) for development and tests. |
| `packages/broker` | `@yz/broker` | `BrokerAdapter` interface, Robinhood MCP adapter (OAuth + MCP over Streamable HTTP), simulated adapter for shadow mode, reconciliation. |
| `packages/intelligence` | `@yz/intelligence` | Model router, slow-brain agents on the Anthropic API with structured, schema-validated outputs, prompt versioning, prompt-injection defence. |
| `apps/api` | `@yz/api` | Fastify server: authentication, MFA, sessions, RBAC, tenant isolation, all HTTP routes, scheduler (market data, trading cycle, reconciliation, learning), execution engine wiring, audit log, system health, kill switches. |
| `apps/web` | `@yz/web` | Vite + React institutional dashboard. |
| `docs/` | | Architecture, security, Robinhood capability map. |
| `scripts/` | | Operator scripts: bootstrap the two users, migrate, rotate secrets. |
| `tests/` | | Cross-package integration tests (isolation, end-to-end simulations). |

## Tenancy and isolation model

- `users` holds exactly the operator-provisioned accounts (no signup route exists). Each user has `role ∈ {admin, trader}`.
- `broker_accounts` belongs to a user (`user_id`) and stores the Robinhood `account_number` plus encrypted OAuth credentials. A user may only ever have broker accounts they own.
- Every trading table carries **both** `user_id` and `broker_account_id`. Repositories in `@yz/db` take a `TenantScope { userId, brokerAccountId }` and add it to every query; there is no un-scoped read/write API for trading data.
- The API resolves a `TenantScope` per request from the session and the requested account; it verifies that the account belongs to the session user (or that the caller is an admin acting explicitly on a named account, which is audited). An admin still cannot trade another user's account: order placement requires the account owner's session.
- `BrokerAdapter` instances are constructed for one `(userId, brokerAccountId, accountNumber)` triple. The adapter refuses any request whose account number differs from the bound one. Tests prove an order for account A can never be sent through adapter B.
- Shared data (market data, features, regimes, research, strategy definitions, shared intelligence profiles) has no tenant columns. Anything that touches capital, risk, positions, orders, performance or settings is tenant-scoped.
- Learning is partitioned: shared profiles (strategy/signal/model/agent intelligence, calibration) are computed from **shadow and live outcomes of both users but never write user state**. User-specific state (risk settings, allocations, autonomy, positions) is only ever changed by that user's authenticated actions or by the bounded safe-adaptation rules operating inside that user's scope.

## Two brains

- **Slow brain** (`@yz/intelligence`): a committee of agents (market regime, quant, market structure, fundamental, news, portfolio manager per user, risk officer, execution, devil's advocate, red team, variant perception analyst). Runs on schedules and on demand, uses the large reasoning model through the model router, produces structured `TradeThesis` objects and research notes. It never talks to the broker.
- **Fast brain** (`@yz/core/fastbrain`): a deterministic, bounded decision model over structured inputs. Emits a probability distribution over `BUY, SELL, HOLD, WAIT, REDUCE, EXIT, CANCEL_ORDER, REPRICE_ORDER`. Fast, explainable, cheap, calibrated by the learning engine. Never bypasses risk.

## Trading cycle (per user, per account)

1. Refresh account state from Robinhood (portfolio, positions, open orders). Reconcile. Any mismatch ⇒ account paused.
2. Data quality gate: quotes, bars and regime must be fresh and consistent, else **no new entries**.
3. Candidate generation (shared): strategies enabled for this user produce `Signal`s; the signal ensemble combines them with regime-aware, calibration-adjusted weights into `TradeCandidate`s with expected edge, confidence and uncertainty.
4. Thesis construction: slow brain builds or refreshes a `TradeThesis` (with historical analogs, variant view, catalysts, pre-mortem) for material candidates.
5. Portfolio check: the user's portfolio engine computes fit (exposure, sector, correlation, beta, drawdown, risk capacity) and adjusts size.
6. Fast brain decision with probabilities.
7. Risk engine (deterministic): per-account limits, global limits, kill switches, data freshness, autonomy level. Produces a `RiskDecision` with reasons. Absolute veto.
8. Execution: order type and price selection from the execution intelligence model; `review_equity_order`; `place_equity_order` with idempotent `ref_id`; monitoring, repricing and cancellation rules.
9. Journal everything: theses, decisions, rejections, orders, fills, audit log entries.
10. Learning: post-trade review on close, profile updates, calibration updates, lessons, missed-opportunity review. Learning outputs are recommendations and bounded parameter updates, never new live logic.

Evaluations are provisional, not permanent. A candidate lives until the next trading-day close, but a rejection only stands for 30 minutes of regular session (capital, data freshness, per-cycle budgets and the committee all change intra-day); after that the candidate is evaluated again, at most four rejections per candidate, so a setup that keeps failing cannot spend model budget all day. An approval or shadow decision stands while the trade it produced lives and reopens the same way once every such trade ended without a fill. A candidate whose calibrated confidence is already under the account minimum is vetoed before the committee runs, since the committee can only lower confidence.

## Autonomy levels

`research_only < shadow < manual_approval < semi_autonomous < fully_autonomous`. Changing the level requires a fresh password (and MFA when enabled) confirmation and is audited. In `semi_autonomous`, the system manages existing positions (reduce/exit/cancel/reprice) and submits new entries only below a per-user notional threshold; larger entries wait for approval. In `fully_autonomous`, entries and exits are submitted without approval, still subject to the risk engine.

## Strategy lifecycle

`research → backtest → out_of_sample → walk_forward → live_shadow → limited_live → live → paused → retired`. Each transition is a recorded promotion review. A strategy can be at different stages per user (user strategy settings) but can never be beyond its global stage.

## Survival mandate ("earn or die")

The desk exists to compound capital, and the code says so. `packages/core/src/survival` turns the
realised record into a deterministic state machine per account; nothing in it forecasts, and
nothing in it can raise risk above the configured limits.

- **Mandate (`computeSurvival`)** — from equity snapshots, closed live and shadow trades and the
  benchmark over the same period it produces a mode: `thriving`, `earning`, `probation`, `survival`,
  `hibernation`. Each mode fixes a live risk multiplier (1.0 → 0), an edge-hurdle multiplier
  (1.0 → 2.0), a net-of-cost hurdle in bps, and a per-cycle budget of new positions. Hibernation
  suspends live entries entirely: every decision runs in shadow until the shadow record proves an
  edge over 20 trades. Demotions are immediate; promotions climb one rung at a time after a dwell.
  It also reports the runway (days to the drawdown limit at the current burn) and alpha versus SPY.
- **Net expected value gate (`netExpectancy`)** — every entry must pay for its own round-trip
  costs (spread, modelled slippage, fees) and clear the mandate's hurdle. Unknown costs are assumed
  at their maximum. Failing trades are rejected as `negative_net_expectancy` and reviewed later by
  the missed-opportunity job, so the hurdle itself is audited.
- **Strategy Darwinism (`assessStrategyFitness`, `darwinianAllocation`)** — each strategy is
  judged on the account's own live record: `scale`, `keep`, `probation`, `cull`, `revive` or
  `incubating`. The daily `learning_darwinism` job moves capital at most ±0.05 toward the
  fitness-proportional share, demotes culled strategies to `live_shadow` (they keep trading in
  shadow and can earn their way back), and proposes revivals for human promotion. Everything is
  written as applied proposals, stage transitions, alerts and audit rows.

Wiring: `loadAccountContext` attaches the mandate (recomputed when older than ten minutes and
persisted in `survival_states`); `resolveMode` forces shadow in hibernation; sizing and the fast
brain's risk capacity are scaled by the live risk multiplier; the risk engine's minimum expected
edge is multiplied by the hurdle multiplier; the portfolio manager agent receives the mandate as
binding context. The dashboard shows it on the Overview page and as a fitness verdict per strategy.

## Fail-closed rules (implemented in the risk engine and the API)

Identity uncertain, account mapping uncertain, market data unreliable, reconciliation failing, risk engine error, broker unreachable ⇒ **no new trades**. Learning infrastructure failing ⇒ trading continues on the last validated strategy versions with adaptation frozen; nothing new is deployed.
