# Robinhood Agentic Trading — capability map

This document records what the platform relies on from Robinhood's **official** Agentic Trading surface, how it is reached, and which parts of the product must be treated as unsupported. It is the design input for `packages/broker/src/robinhood/*`.

Nothing here is scraped or reverse engineered. The only integration used is the hosted Model Context Protocol (MCP) server that Robinhood publishes for agents. Unofficial web APIs are explicitly out of scope and are refused by the adapter.

## The surface

| Item | Value |
|---|---|
| Transport | MCP over Streamable HTTP |
| Endpoint | `https://agent.robinhood.com/mcp/trading` |
| Authentication | OAuth 2.1 authorization-code with PKCE (S256). Dynamic client registration (RFC 7591) at `https://agent.robinhood.com/oauth/trading/register`; authorization at `https://robinhood.com/oauth`; token endpoint `https://api.robinhood.com/oauth2/token/`; scope `internal`. Public client (`token_endpoint_auth_method: none`). Refresh tokens are single-use and rotate on every grant. **Robinhood's consent page only completes for loopback redirect URIs** (a hosted `https://…/callback` lands on `robinhood.com/oauth/error`, "Uh oh! Something's gone wrong"), so the platform registers `http://127.0.0.1:<ROBINHOOD_LOOPBACK_PORT>/callback` as a native client and the user pastes the address the browser was sent to into Settings (`POST /api/accounts/:id/broker/complete`). The RFC 8707 `resource` indicator is sent on authorize, exchange and refresh. |
| Discovery | An unauthenticated `initialize` answers `401` with `WWW-Authenticate` pointing at protected-resource metadata; the adapter tries RFC 9728 / RFC 8414 discovery first and only falls back to the endpoints above. |
| Account model | The user opens a dedicated **Agentic account** in the Robinhood app. `get_accounts` returns every brokerage account with an `agentic_allowed` flag. Exactly one account is tradable by the agent; every other account is read-only. Orders to a non-agentic account are rejected upstream. |
| Account type | Agentic accounts are `limited_margin`: instant settlement of sale proceeds, **no leverage**, no margin borrowing. |
| Asset classes | Equities (launch), options (rolling out), crypto (added July 2026). Event contracts / futures announced but not exposed on the trading tools we use. |
| Rate limit | Unpublished. Measured by a community probe at ~4 calls/s sustained with `RATE_LIMITED` errors at ~8 calls/s that clear after ~5 s. The adapter enforces a token bucket of 3 calls/s per credential and backs off on `RATE_LIMITED`. |
| Latency | p50 ≈ 150 ms, p95 ≈ 350 ms per call. |

## What Robinhood is the source of truth for

Per the specification, Robinhood owns the actual state of:

- cash and buying power (`get_portfolio.buying_power.buying_power` is the authoritative order-gating figure; `get_accounts` explicitly does **not** return reliable buying power)
- positions (`get_equity_positions`, `get_option_positions`, `get_crypto_positions`)
- orders and their lifecycle (`get_equity_orders`, `get_option_orders`)
- fills (`cumulative_quantity`, `average_price`, `fees` on the order object; there is no separate executions feed)
- realized P&L (`get_realized_pnl`, `get_pnl_trade_history`)
- tax lots (`get_equity_tax_lots`)

The platform reconciles its internal ledger against these on a schedule and after every execution. A mismatch pauses the affected account (fail closed) — never the other user's account unless the failure is systemic.

## Tools the adapter uses

### Account and portfolio (read)

| Tool | Purpose in the platform |
|---|---|
| `get_accounts` | Enumerate accounts, find the one with `agentic_allowed=true`, capture `account_number`, `rhs_account_number`, `type`, `brokerage_account_type`. Stored per user at connection time. |
| `get_portfolio` | Total value, equity/options/crypto value, cash, pending deposits, **buying power**. Polled for the account header and the risk engine. |
| `get_equity_positions` | Symbol, quantity, `average_buy_price`, `shares_available_for_sells`, holds. Sellable quantity is always `shares_available_for_sells`, never `quantity`. |
| `get_option_positions` | Per-leg option positions (only when options are enabled for the account). |
| `get_equity_tax_lots` | Cost basis and holding period per lot. |
| `get_realized_pnl` | Realized P&L buckets for performance reconciliation. |
| `get_pnl_trade_history` | Per-trade realized P&L (FIFO) for post-trade review cross-checks. |

### Market data (read)

| Tool | Purpose |
|---|---|
| `get_equity_quotes` | Real-time last trade, bid/ask with venue timestamps, previous close, instrument `state`. Up to 20 symbols per call keeps `closes`. Every quote is stored with source, venue timestamp, receipt time, and a freshness classification. |
| `get_equity_historicals` | OHLCV bars, split-adjusted by default, `interpolated` bars flagged and discarded by the feature engine. Up to 10 symbols per call. |
| `get_equity_price_book` | Level-2 depth for the execution engine's spread/liquidity model. |
| `get_equity_fundamentals`, `get_financials`, `get_equity_analyst_ratings`, `get_earnings_results`, `get_earnings_calendar`, `get_equity_news`, `get_sec_filing_*` | Inputs to the fundamental, news, catalyst and variant-perception engines. Treated as **data**, never as instructions. |
| `get_equity_technical_indicators` | Cross-check only. The platform computes its own indicators from bars so that backtests and live decisions share one implementation. |
| `get_indexes`, `get_index_quotes`, `get_index_historicals` | SPX, NDX, VIX and friends for the market regime engine. |
| `get_equity_tradability` | Called before every order: `tradeable`, fractional eligibility, session eligibility, halts, `account_type_tradabilities` (`position_closing_only` handling). |
| `search` | Symbol resolution. Order writes never use fuzzy search; the platform resolves symbols by exact ticker only. |
| `get_option_chains`, `get_option_instruments`, `get_option_quotes`, `get_option_historicals` | Options/volatility analytics (IV, greeks, expected move) when enabled for the account. |

### Order actions (write — agentic account only)

| Tool | Notes |
|---|---|
| `review_equity_order` | Simulates the order: live quote, price collar, buying-power/PDT/halt alerts. The execution engine **always** reviews before placing and persists the review result on the order record. |
| `place_equity_order` | `account_number, symbol, side ('buy'|'sell'), type ('market'|'limit'|'stop_market'|'stop_limit'), quantity | dollar_amount, limit_price, stop_price, time_in_force ('gfd'|'gtc'), market_hours ('regular_hours'|'extended_hours'|'all_day_hours'), tax_lots[], ref_id`. `ref_id` is a client UUID used for idempotency; the platform generates it once per internal order and re-sends the same value on transport retries. Fractional quantities only with market + regular_hours. Extended/overnight sessions are limit-only. |
| `cancel_equity_order` | Asynchronous. `accepted=true` means the cancel was accepted, not completed; the platform polls `get_equity_orders` until a terminal state. |
| `review_option_order`, `place_option_order`, `cancel_option_order` | Options (limit / stop_limit, regular hours). Used only when the account has options enabled in platform settings **and** at Robinhood. |
| `place_advanced_order`, `review_advanced_order`, `cancel_advanced_order`, `get_advanced_orders` | OCO groups. Not used by the execution engine in this version; listed so the capability is not forgotten. |

Order states observed upstream: `new, queued, unconfirmed, confirmed, partially_filled, filled, cancelled, rejected, failed, voided, pending_cancelled, partially_filled_rest_cancelled, locating, locate_failed`. The adapter maps these to the platform's order lifecycle; unknown states are treated as *unknown* and trigger a reconciliation, never a guess.

## Explicit constraints the platform enforces

1. **Long only.** Agentic accounts do not support short selling and carry no leverage. The strategy library therefore treats every "sell" signal as reduce/exit of an existing long, and options are the only defined-risk way to express a negative view.
2. **Sellable quantity** comes from `shares_available_for_sells`.
3. **Fractional shares** are allowed only for market orders in regular hours. The sizing engine rounds to whole shares whenever a limit order is used.
4. **Sessions.** Market and stop orders only in `regular_hours`. Outside regular hours the execution engine uses marketable limit orders tagged to the right session or waits.
5. **Review then place.** No order is placed without a stored `review_equity_order` result taken within the last 60 seconds.
6. **One agentic account per credential.** The broker account record stores the `account_number`; every call carries it explicitly. The adapter refuses any call whose `account_number` differs from the one bound to the adapter instance.
7. **Tokens are per user**, encrypted at rest with the platform master key, and never shared or exposed to the frontend.
8. **No unofficial APIs.** The adapter has no code path to `robinhood.com`'s web API.

## What we do not pretend to have

- No streaming market data: quotes are polled. Freshness is measured and stale quotes block new entries.
- No separate execution/fill feed: fills are derived from order objects.
- No paper-trading endpoint at Robinhood: shadow mode is simulated inside the platform from live quotes and is always labelled *SIMULATED*.
- No published rate limit or SLA.
- Options and crypto rollout status differ per account; the platform reads capability from `get_accounts` / tradability and from the user's own settings, and never assumes.
