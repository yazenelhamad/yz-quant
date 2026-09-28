import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, id, tenantColumns, ts, updatedAt } from "./_common.js";
import { users } from "./auth.js";

export const brokerAccounts = pgTable("broker_accounts", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id),
  kind: text("kind").$type<"robinhood_agentic" | "simulated">().notNull(),
  label: text("label").notNull(),
  /** Broker account number (masked in UI). */
  accountNumber: text("account_number").notNull(),
  rhsAccountNumber: text("rhs_account_number"),
  agenticAllowed: boolean("agentic_allowed").notNull().default(false),
  accountType: text("account_type").notNull().default("unknown"),
  brokerageAccountType: text("brokerage_account_type"),
  optionsEnabledAtBroker: boolean("options_enabled_at_broker").notNull().default(false),
  status: text("status").notNull().default("not_connected"),
  statusDetail: text("status_detail"),
  lastHealthyAt: ts("last_healthy_at"),
  lastReconciledAt: ts("last_reconciled_at"),
  reconciliationOk: boolean("reconciliation_ok").notNull().default(false),
  /** Per-account trading configuration that is not a risk limit. */
  autonomyLevel: text("autonomy_level").notNull().default("research_only"),
  tradingPaused: boolean("trading_paused").notNull().default(true),
  pausedReason: text("paused_reason"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("broker_accounts_user_idx").on(t.userId), uniqueIndex("broker_accounts_user_number_uq").on(t.userId, t.accountNumber)]);

/** Encrypted OAuth credential. One row per broker account; the plaintext never leaves the server. */
export const brokerCredentials = pgTable("broker_credentials", {
  id: id(),
  ...tenantColumns(),
  /** AES-256-GCM envelope (versioned) of {client_id, access_token, refresh_token, expires_at}. */
  credentialEnc: text("credential_enc").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  expiresAt: ts("expires_at"),
  lastRefreshedAt: ts("last_refreshed_at"),
  revokedAt: ts("revoked_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("broker_credentials_account_uq").on(t.brokerAccountId)]);

/** Pending OAuth authorization flows (PKCE state). Short-lived. */
export const brokerOauthStates = pgTable("broker_oauth_states", {
  id: id(),
  ...tenantColumns(),
  state: text("state").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("broker_oauth_states_state_uq").on(t.state)]);

export const portfolioSnapshots = pgTable("portfolio_snapshots", {
  id: id(),
  ...tenantColumns(),
  asOf: ts("as_of").notNull(),
  totalValue: doublePrecision("total_value").notNull(),
  equityValue: doublePrecision("equity_value").notNull(),
  optionsValue: doublePrecision("options_value").notNull().default(0),
  cryptoValue: doublePrecision("crypto_value").notNull().default(0),
  cash: doublePrecision("cash").notNull(),
  pendingDeposits: doublePrecision("pending_deposits").notNull().default(0),
  buyingPower: doublePrecision("buying_power").notNull(),
  unleveragedBuyingPower: doublePrecision("unleveraged_buying_power").notNull(),
  currency: text("currency").notNull().default("USD"),
  /** Internal computations at snapshot time. */
  dailyPnl: doublePrecision("daily_pnl"),
  totalPnl: doublePrecision("total_pnl"),
  drawdownPct: doublePrecision("drawdown_pct"),
  exposurePct: doublePrecision("exposure_pct"),
  source: text("source").notNull(),
  raw: jsonb("raw"),
  createdAt: createdAt(),
}, (t) => [index("portfolio_snapshots_scope_idx").on(t.userId, t.brokerAccountId, t.asOf)]);

export const positions = pgTable("positions", {
  id: id(),
  ...tenantColumns(),
  symbol: text("symbol").notNull(),
  assetClass: text("asset_class").notNull().default("equity"),
  quantity: doublePrecision("quantity").notNull(),
  intradayQuantity: doublePrecision("intraday_quantity").notNull().default(0),
  sharesAvailableForSells: doublePrecision("shares_available_for_sells").notNull(),
  averageCost: doublePrecision("average_cost"),
  markPrice: doublePrecision("mark_price"),
  marketValue: doublePrecision("market_value"),
  unrealizedPnl: doublePrecision("unrealized_pnl"),
  /** Internal trade currently managing this position, if any. */
  tradeId: text("trade_id"),
  strategyId: text("strategy_id"),
  asOf: ts("as_of").notNull(),
  source: text("source").notNull(),
  raw: jsonb("raw"),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("positions_scope_symbol_uq").on(t.userId, t.brokerAccountId, t.symbol, t.assetClass)]);

export const orders = pgTable("orders", {
  id: id(),
  ...tenantColumns(),
  brokerOrderId: text("broker_order_id"),
  refId: text("ref_id").notNull(),
  tradeId: text("trade_id"),
  strategyId: text("strategy_id"),
  strategyVersionId: text("strategy_version_id"),
  accountNumber: text("account_number").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side").$type<"buy" | "sell">().notNull(),
  type: text("type").notNull(),
  quantity: doublePrecision("quantity"),
  dollarAmount: doublePrecision("dollar_amount"),
  limitPrice: doublePrecision("limit_price"),
  stopPrice: doublePrecision("stop_price"),
  timeInForce: text("time_in_force").notNull().default("gfd"),
  marketHours: text("market_hours").notNull().default("regular_hours"),
  mode: text("mode").$type<"live" | "shadow">().notNull(),
  state: text("state").notNull().default("new"),
  cumulativeQuantity: doublePrecision("cumulative_quantity").notNull().default(0),
  averagePrice: doublePrecision("average_price"),
  fees: doublePrecision("fees").notNull().default(0),
  arrivalPrice: doublePrecision("arrival_price"),
  expectedSlippageBps: doublePrecision("expected_slippage_bps"),
  review: jsonb("review"),
  reviewedAt: ts("reviewed_at"),
  submittedAt: ts("submitted_at"),
  lastBrokerSyncAt: ts("last_broker_sync_at"),
  reprices: integer("reprices").notNull().default(0),
  cancelRequestedAt: ts("cancel_requested_at"),
  error: text("error"),
  raw: jsonb("raw"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("orders_ref_uq").on(t.refId),
  index("orders_scope_idx").on(t.userId, t.brokerAccountId, t.createdAt),
  index("orders_broker_id_idx").on(t.brokerOrderId),
  index("orders_trade_idx").on(t.tradeId),
]);

export const fills = pgTable("fills", {
  id: id(),
  ...tenantColumns(),
  orderId: text("order_id").notNull(),
  brokerOrderId: text("broker_order_id"),
  tradeId: text("trade_id"),
  symbol: text("symbol").notNull(),
  side: text("side").$type<"buy" | "sell">().notNull(),
  quantity: doublePrecision("quantity").notNull(),
  price: doublePrecision("price").notNull(),
  fees: doublePrecision("fees").notNull().default(0),
  derived: boolean("derived").notNull().default(true),
  mode: text("mode").$type<"live" | "shadow">().notNull(),
  at: ts("at").notNull(),
  createdAt: createdAt(),
}, (t) => [index("fills_scope_idx").on(t.userId, t.brokerAccountId, t.at), index("fills_order_idx").on(t.orderId)]);

export const taxLots = pgTable("tax_lots", {
  id: id(),
  ...tenantColumns(),
  symbol: text("symbol").notNull(),
  lotId: text("lot_id").notNull(),
  quantity: doublePrecision("quantity").notNull(),
  quantityAvailable: doublePrecision("quantity_available").notNull(),
  costPerShare: doublePrecision("cost_per_share"),
  openDate: text("open_date"),
  term: text("term").notNull().default("unknown"),
  asOf: ts("as_of").notNull(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("tax_lots_scope_lot_uq").on(t.userId, t.brokerAccountId, t.lotId)]);

export const reconciliations = pgTable("reconciliations", {
  id: id(),
  ...tenantColumns(),
  ok: boolean("ok").notNull(),
  positionMismatches: jsonb("position_mismatches").$type<unknown[]>().notNull().default([]),
  orderMismatches: jsonb("order_mismatches").$type<unknown[]>().notNull().default([]),
  cashDifference: doublePrecision("cash_difference"),
  unexpectedPositions: jsonb("unexpected_positions").$type<string[]>().notNull().default([]),
  action: text("action").notNull(), // none | paused_account | paused_all
  detail: text("detail"),
  at: ts("at").notNull().defaultNow(),
}, (t) => [index("reconciliations_scope_idx").on(t.userId, t.brokerAccountId, t.at)]);
