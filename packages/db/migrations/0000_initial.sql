CREATE TABLE "login_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"ip" text,
	"success" boolean NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"device_label" text,
	"mfa_verified" boolean DEFAULT false NOT NULL,
	"step_up_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text DEFAULT 'trader' NOT NULL,
	"password_hash" text NOT NULL,
	"mfa_secret_enc" text,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_recovery_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"password_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broker_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"account_number" text NOT NULL,
	"rhs_account_number" text,
	"agentic_allowed" boolean DEFAULT false NOT NULL,
	"account_type" text DEFAULT 'unknown' NOT NULL,
	"brokerage_account_type" text,
	"options_enabled_at_broker" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'not_connected' NOT NULL,
	"status_detail" text,
	"last_healthy_at" timestamp with time zone,
	"last_reconciled_at" timestamp with time zone,
	"reconciliation_ok" boolean DEFAULT false NOT NULL,
	"autonomy_level" text DEFAULT 'research_only' NOT NULL,
	"trading_paused" boolean DEFAULT true NOT NULL,
	"paused_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broker_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"credential_enc" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"last_refreshed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broker_oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"state" text NOT NULL,
	"code_verifier" text NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"order_id" text NOT NULL,
	"broker_order_id" text,
	"trade_id" text,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"quantity" double precision NOT NULL,
	"price" double precision NOT NULL,
	"fees" double precision DEFAULT 0 NOT NULL,
	"derived" boolean DEFAULT true NOT NULL,
	"mode" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"broker_order_id" text,
	"ref_id" text NOT NULL,
	"trade_id" text,
	"strategy_id" text,
	"strategy_version_id" text,
	"account_number" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"type" text NOT NULL,
	"quantity" double precision,
	"dollar_amount" double precision,
	"limit_price" double precision,
	"stop_price" double precision,
	"time_in_force" text DEFAULT 'gfd' NOT NULL,
	"market_hours" text DEFAULT 'regular_hours' NOT NULL,
	"mode" text NOT NULL,
	"state" text DEFAULT 'new' NOT NULL,
	"cumulative_quantity" double precision DEFAULT 0 NOT NULL,
	"average_price" double precision,
	"fees" double precision DEFAULT 0 NOT NULL,
	"arrival_price" double precision,
	"expected_slippage_bps" double precision,
	"review" jsonb,
	"reviewed_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"last_broker_sync_at" timestamp with time zone,
	"reprices" integer DEFAULT 0 NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"error" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"total_value" double precision NOT NULL,
	"equity_value" double precision NOT NULL,
	"options_value" double precision DEFAULT 0 NOT NULL,
	"crypto_value" double precision DEFAULT 0 NOT NULL,
	"cash" double precision NOT NULL,
	"pending_deposits" double precision DEFAULT 0 NOT NULL,
	"buying_power" double precision NOT NULL,
	"unleveraged_buying_power" double precision NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"daily_pnl" double precision,
	"total_pnl" double precision,
	"drawdown_pct" double precision,
	"exposure_pct" double precision,
	"source" text NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"symbol" text NOT NULL,
	"asset_class" text DEFAULT 'equity' NOT NULL,
	"quantity" double precision NOT NULL,
	"intraday_quantity" double precision DEFAULT 0 NOT NULL,
	"shares_available_for_sells" double precision NOT NULL,
	"average_cost" double precision,
	"mark_price" double precision,
	"market_value" double precision,
	"unrealized_pnl" double precision,
	"trade_id" text,
	"strategy_id" text,
	"as_of" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"raw" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"ok" boolean NOT NULL,
	"position_mismatches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"order_mismatches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cash_difference" double precision,
	"unexpected_positions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action" text NOT NULL,
	"detail" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_lots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"symbol" text NOT NULL,
	"lot_id" text NOT NULL,
	"quantity" double precision NOT NULL,
	"quantity_available" double precision NOT NULL,
	"cost_per_share" double precision,
	"open_date" text,
	"term" text DEFAULT 'unknown' NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "earnings_events" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"report_at" timestamp with time zone NOT NULL,
	"timing" text,
	"eps_estimate" double precision,
	"eps_actual" double precision,
	"revenue_estimate" double precision,
	"revenue_actual" double precision,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "economic_events" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"importance" text DEFAULT 'medium' NOT NULL,
	"consensus" text,
	"actual" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "features" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"feature_version" text NOT NULL,
	"values" jsonb NOT NULL,
	"freshness" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"symbol" text PRIMARY KEY NOT NULL,
	"name" text,
	"sector" text,
	"industry" text,
	"asset_class" text DEFAULT 'equity' NOT NULL,
	"state" text DEFAULT 'unknown' NOT NULL,
	"tradeable" boolean,
	"fractional" boolean,
	"market_cap" double precision,
	"avg_dollar_volume_20" double precision,
	"beta" double precision,
	"delisted_at" timestamp with time zone,
	"meta" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_bars" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"interval" text NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" double precision NOT NULL,
	"interpolated" boolean DEFAULT false NOT NULL,
	"adjusted" text DEFAULT 'split' NOT NULL,
	"source" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"last" double precision NOT NULL,
	"bid" double precision,
	"ask" double precision,
	"previous_close" double precision,
	"last_trade_at" timestamp with time zone,
	"session" text DEFAULT 'unknown' NOT NULL,
	"instrument_state" text DEFAULT 'unknown' NOT NULL,
	"source" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"reliability" double precision DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_regimes" (
	"id" text PRIMARY KEY NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"primary" text NOT NULL,
	"probabilities" jsonb NOT NULL,
	"confidence" double precision NOT NULL,
	"abnormality" double precision NOT NULL,
	"metrics" jsonb NOT NULL,
	"family_bias" jsonb NOT NULL,
	"explanation" jsonb NOT NULL,
	"data_quality" text NOT NULL,
	"engine_version" text NOT NULL,
	"forward_return_5d" double precision,
	"forward_vol_5d" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_events" (
	"id" text PRIMARY KEY NOT NULL,
	"content_hash" text NOT NULL,
	"symbols" jsonb NOT NULL,
	"headline" text NOT NULL,
	"summary" text,
	"source" text NOT NULL,
	"source_tier" double precision DEFAULT 7 NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"url" text,
	"interpretation" jsonb,
	"genuinely_new" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"strategy_key" text NOT NULL,
	"symbol" text NOT NULL,
	"direction" text NOT NULL,
	"value" double precision NOT NULL,
	"confidence" double precision NOT NULL,
	"horizon_days" double precision NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"feature_version" text NOT NULL,
	"input_freshness" text NOT NULL,
	"explanation" text DEFAULT '' NOT NULL,
	"realized_return_pct" double precision,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"candidate_id" text NOT NULL,
	"portfolio_fit" double precision NOT NULL,
	"size_multiplier" double precision NOT NULL,
	"proposed_quantity" double precision NOT NULL,
	"fast_brain" jsonb,
	"risk_decision_id" text,
	"final_status" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"strategy_id" text NOT NULL,
	"strategy_key" text NOT NULL,
	"strategy_version_id" text,
	"direction" text NOT NULL,
	"ensemble" jsonb NOT NULL,
	"expected_upside_pct" double precision NOT NULL,
	"expected_downside_pct" double precision NOT NULL,
	"holding_period_days" double precision NOT NULL,
	"catalyst" text,
	"catalyst_at" timestamp with time zone,
	"liquidity_score" double precision NOT NULL,
	"regime_fit" double precision NOT NULL,
	"historical_similarity" jsonb,
	"status" text DEFAULT 'candidate' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "predictions" (
	"id" text PRIMARY KEY NOT NULL,
	"model_name" text NOT NULL,
	"model_version" text NOT NULL,
	"prompt_version" text,
	"feature_version" text,
	"symbol" text NOT NULL,
	"kind" text NOT NULL,
	"horizon_days" double precision,
	"predicted" jsonb NOT NULL,
	"confidence" double precision,
	"as_of" timestamp with time zone NOT NULL,
	"realized" jsonb,
	"correct" boolean,
	"resolved_at" timestamp with time zone,
	"latency_ms" double precision,
	"cost_usd" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"family" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"visibility" text DEFAULT 'shared' NOT NULL,
	"supported_regimes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stage" text DEFAULT 'research' NOT NULL,
	"current_version_id" text,
	"globally_disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_stage_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"strategy_id" text NOT NULL,
	"user_id" text,
	"broker_account_id" text,
	"from_stage" text NOT NULL,
	"to_stage" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb,
	"decided_by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"strategy_id" text NOT NULL,
	"version" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"change_summary" text NOT NULL,
	"change_reason" text NOT NULL,
	"proposed_by_kind" text NOT NULL,
	"proposed_by_id" text NOT NULL,
	"backtest_result_id" text,
	"out_of_sample_result_id" text,
	"walk_forward_result_id" text,
	"shadow_result_summary" jsonb,
	"approval_status" text DEFAULT 'proposed' NOT NULL,
	"approved_by" text,
	"deployed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_strategy_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"strategy_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"stage" text DEFAULT 'research' NOT NULL,
	"capital_allocation" double precision DEFAULT 0 NOT NULL,
	"max_position_pct" double precision DEFAULT 0.05 NOT NULL,
	"max_loss_per_trade_pct" double precision DEFAULT 0.01 NOT NULL,
	"allowed_symbols" jsonb,
	"blocked_symbols" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"options_allowed" boolean DEFAULT false NOT NULL,
	"min_confidence" double precision,
	"min_expected_edge" double precision,
	"adaptive_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"trade_id" text NOT NULL,
	"thesis_id" text,
	"symbol" text NOT NULL,
	"action" text NOT NULL,
	"quantity" double precision NOT NULL,
	"notional" double precision NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"order_id" text NOT NULL,
	"broker_order_id" text,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"expected_price" double precision NOT NULL,
	"arrival_price" double precision NOT NULL,
	"fill_price" double precision,
	"expected_slippage_bps" double precision NOT NULL,
	"actual_slippage_bps" double precision,
	"time_to_fill_seconds" double precision,
	"partial" boolean DEFAULT false NOT NULL,
	"missed" boolean DEFAULT false NOT NULL,
	"reprices" double precision DEFAULT 0 NOT NULL,
	"cancelled" boolean DEFAULT false NOT NULL,
	"liquidity_bucket" text NOT NULL,
	"session" text NOT NULL,
	"mode" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performance_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"period" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"mode" text NOT NULL,
	"stats" jsonb NOT NULL,
	"by_strategy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rejected_trades" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"candidate_id" text,
	"symbol" text NOT NULL,
	"strategy_id" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"detail" text NOT NULL,
	"expected_edge" double precision NOT NULL,
	"confidence" double precision NOT NULL,
	"regime" text NOT NULL,
	"price_at_rejection" double precision,
	"rejected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subsequent_return_pct" jsonb,
	"review_verdict" text,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "risk_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"candidate_id" text,
	"trade_id" text,
	"symbol" text NOT NULL,
	"action" text NOT NULL,
	"verdict" text NOT NULL,
	"requested_quantity" double precision NOT NULL,
	"approved_quantity" double precision NOT NULL,
	"approved_notional" double precision NOT NULL,
	"checks" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"failed_closed" boolean DEFAULT false NOT NULL,
	"risk_engine_version" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"settings" jsonb NOT NULL,
	"version" double precision DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"trade_id" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"reason" text NOT NULL,
	"detail" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_theses" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"candidate_id" text,
	"trade_id" text,
	"symbol" text NOT NULL,
	"strategy_id" text NOT NULL,
	"strategy_version_id" text,
	"direction" text NOT NULL,
	"expected_edge" double precision NOT NULL,
	"confidence" double precision NOT NULL,
	"calibrated_confidence" double precision NOT NULL,
	"market_regime" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"thesis" jsonb NOT NULL,
	"model_name" text NOT NULL,
	"model_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"mode" text NOT NULL,
	"symbol" text NOT NULL,
	"strategy_id" text NOT NULL,
	"strategy_version_id" text,
	"thesis_id" text,
	"candidate_id" text,
	"state" text DEFAULT 'candidate' NOT NULL,
	"direction" text DEFAULT 'long' NOT NULL,
	"entry_quantity" double precision DEFAULT 0 NOT NULL,
	"open_quantity" double precision DEFAULT 0 NOT NULL,
	"average_entry_price" double precision,
	"average_exit_price" double precision,
	"realized_pnl" double precision DEFAULT 0 NOT NULL,
	"fees" double precision DEFAULT 0 NOT NULL,
	"mae_pct" double precision,
	"mfe_pct" double precision,
	"initial_confidence" double precision NOT NULL,
	"expected_edge" double precision NOT NULL,
	"expected_downside_pct" double precision NOT NULL,
	"invalidation_price" double precision,
	"target_price" double precision,
	"expected_holding_days" double precision,
	"regime_at_entry" text NOT NULL,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"exit_reason" text,
	"versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "adaptation_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"broker_account_id" text,
	"target" text NOT NULL,
	"key" text NOT NULL,
	"current_value" double precision NOT NULL,
	"proposed_value" double precision NOT NULL,
	"bounds" jsonb NOT NULL,
	"evidence" text NOT NULL,
	"auto_applicable" boolean NOT NULL,
	"requires_validation_pipeline" boolean NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_intelligence_profiles" (
	"agent_name" text PRIMARY KEY NOT NULL,
	"profile" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backtests" (
	"id" text PRIMARY KEY NOT NULL,
	"strategy_key" text NOT NULL,
	"strategy_version_id" text,
	"kind" text NOT NULL,
	"config" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"equity_curve" jsonb NOT NULL,
	"trades" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data_fingerprint" text NOT NULL,
	"requested_by" text NOT NULL,
	"duration_ms" double precision NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "confidence_calibration" (
	"key" text PRIMARY KEY NOT NULL,
	"profile" jsonb NOT NULL,
	"adjustment" double precision DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"hypothesis" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"proposed_by" text NOT NULL,
	"design" jsonb NOT NULL,
	"results" jsonb,
	"conclusion" text,
	"recommendation" text,
	"linked_strategy_id" text,
	"linked_backtest_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_digests" (
	"id" text PRIMARY KEY NOT NULL,
	"period" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"user_id" text,
	"broker_account_id" text,
	"digest" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_intelligence_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"model_name" text NOT NULL,
	"model_version" text NOT NULL,
	"profile" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_trade_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"trade_id" text NOT NULL,
	"classification" text NOT NULL,
	"review" jsonb NOT NULL,
	"reviewer_version" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_intelligence_profiles" (
	"signal_key" text PRIMARY KEY NOT NULL,
	"profile" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_intelligence_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"strategy_id" text NOT NULL,
	"strategy_key" text NOT NULL,
	"user_id" text,
	"broker_account_id" text,
	"mode" text NOT NULL,
	"profile" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_lessons" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"broker_account_id" text,
	"trade_id" text,
	"strategy_key" text NOT NULL,
	"regime" text NOT NULL,
	"setup" text NOT NULL,
	"expected" text NOT NULL,
	"actual" text NOT NULL,
	"lesson" text NOT NULL,
	"action" text NOT NULL,
	"tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence_impact" double precision DEFAULT 1 NOT NULL,
	"times_confirmed" integer DEFAULT 0 NOT NULL,
	"times_contradicted" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_memory" (
	"trade_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"mode" text NOT NULL,
	"symbol" text NOT NULL,
	"sector" text,
	"strategy_key" text NOT NULL,
	"regime" text NOT NULL,
	"signals" jsonb NOT NULL,
	"features" jsonb NOT NULL,
	"vector" jsonb NOT NULL,
	"entry_price" double precision NOT NULL,
	"exit_price" double precision,
	"holding_days" double precision,
	"position_pct" double precision NOT NULL,
	"confidence" double precision NOT NULL,
	"expected_edge" double precision NOT NULL,
	"predicted_downside_pct" double precision NOT NULL,
	"actual_return_pct" double precision,
	"mae_pct" double precision,
	"mfe_pct" double precision,
	"slippage_bps" double precision,
	"execution_quality" double precision,
	"exit_reason" text,
	"review_classification" text,
	"lessons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analyst_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"eps_up" integer DEFAULT 0 NOT NULL,
	"eps_down" integer DEFAULT 0 NOT NULL,
	"revenue_up" integer DEFAULT 0 NOT NULL,
	"revenue_down" integer DEFAULT 0 NOT NULL,
	"rating_upgrades" integer DEFAULT 0 NOT NULL,
	"rating_downgrades" integer DEFAULT 0 NOT NULL,
	"price_target_mean" double precision,
	"price_target_change_pct" double precision,
	"eps_mean" double precision,
	"eps_std_dev" double precision,
	"eps_low" double precision,
	"eps_high" double precision,
	"analyst_count" integer,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalysts" (
	"id" text PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"expected_date" timestamp with time zone,
	"probability" double precision NOT NULL,
	"potential_impact_pct" double precision NOT NULL,
	"consensus_expects_it" text DEFAULT 'unknown' NOT NULL,
	"priced_in_score" double precision NOT NULL,
	"reaction_speed" text NOT NULL,
	"status" text DEFAULT 'upcoming' NOT NULL,
	"outcome" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_profile_history" (
	"id" text PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"version" integer NOT NULL,
	"profile" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_profiles" (
	"ticker" text PRIMARY KEY NOT NULL,
	"profile" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consensus_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"model" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expectations_records" (
	"id" text PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"catalyst" text NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"consensus" jsonb NOT NULL,
	"narrative" text NOT NULL,
	"options_implied_move_pct" double precision,
	"price_before" double precision NOT NULL,
	"system_forecast" jsonb NOT NULL,
	"system_confidence" double precision NOT NULL,
	"actual_result" jsonb,
	"price_after" double precision,
	"reaction_pct" double precision,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "internal_forecasts" (
	"id" text PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"forecast" jsonb NOT NULL,
	"model_name" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variant_views" (
	"id" text PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"score" double precision NOT NULL,
	"recommended_action" text NOT NULL,
	"view" jsonb NOT NULL,
	"outcome_return_pct" double precision,
	"outcome_correct" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_registry" (
	"name" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"influence_weight" double precision DEFAULT 1 NOT NULL,
	"prompt_version" text NOT NULL,
	"model_role" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"broker_account_id" text,
	"severity" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"acknowledged" boolean DEFAULT false NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"category" text NOT NULL,
	"action" text NOT NULL,
	"user_id" text,
	"broker_account_id" text,
	"actor_user_id" text,
	"strategy_id" text,
	"strategy_version_id" text,
	"model_name" text,
	"model_version" text,
	"prompt_version" text,
	"trade_id" text,
	"order_id" text,
	"result" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"ip" text,
	"session_id" text
);
--> statement-breakpoint
CREATE TABLE "global_risk_state" (
	"id" text PRIMARY KEY NOT NULL,
	"live_execution_disabled" boolean DEFAULT false NOT NULL,
	"force_shadow_mode" boolean DEFAULT false NOT NULL,
	"paused_users" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disabled_strategy_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kill_switch_active" boolean DEFAULT false NOT NULL,
	"kill_switch_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kill_switch_note" text,
	"kill_switch_triggered_at" timestamp with time zone,
	"kill_switch_triggered_by" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_checks" (
	"name" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"metrics" jsonb,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"user_id" text,
	"broker_account_id" text,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"detail" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "kill_switches" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allow_risk_reducing_exits" boolean DEFAULT true NOT NULL,
	"triggered_at" timestamp with time zone,
	"triggered_by" text,
	"note" text,
	"released_at" timestamp with time zone,
	"released_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_outputs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_name" text NOT NULL,
	"model_name" text NOT NULL,
	"model_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"user_id" text,
	"broker_account_id" text,
	"symbol" text,
	"candidate_id" text,
	"thesis_id" text,
	"input" jsonb,
	"output" jsonb,
	"valid" boolean NOT NULL,
	"validation_error" text,
	"latency_ms" double precision,
	"input_tokens" double precision,
	"output_tokens" double precision,
	"cost_usd" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_registry" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"provider" text NOT NULL,
	"role" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"routing_weight" double precision DEFAULT 1 NOT NULL,
	"cost_per_mtok_in" double precision,
	"cost_per_mtok_out" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_events" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"component" text NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broker_accounts" ADD CONSTRAINT "broker_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "login_attempts_email_idx" ON "login_attempts" USING btree ("email","at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "broker_accounts_user_idx" ON "broker_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "broker_accounts_user_number_uq" ON "broker_accounts" USING btree ("user_id","account_number");--> statement-breakpoint
CREATE UNIQUE INDEX "broker_credentials_account_uq" ON "broker_credentials" USING btree ("broker_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "broker_oauth_states_state_uq" ON "broker_oauth_states" USING btree ("state");--> statement-breakpoint
CREATE INDEX "fills_scope_idx" ON "fills" USING btree ("user_id","broker_account_id","at");--> statement-breakpoint
CREATE INDEX "fills_order_idx" ON "fills" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_ref_uq" ON "orders" USING btree ("ref_id");--> statement-breakpoint
CREATE INDEX "orders_scope_idx" ON "orders" USING btree ("user_id","broker_account_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_broker_id_idx" ON "orders" USING btree ("broker_order_id");--> statement-breakpoint
CREATE INDEX "orders_trade_idx" ON "orders" USING btree ("trade_id");--> statement-breakpoint
CREATE INDEX "portfolio_snapshots_scope_idx" ON "portfolio_snapshots" USING btree ("user_id","broker_account_id","as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_scope_symbol_uq" ON "positions" USING btree ("user_id","broker_account_id","symbol","asset_class");--> statement-breakpoint
CREATE INDEX "reconciliations_scope_idx" ON "reconciliations" USING btree ("user_id","broker_account_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_lots_scope_lot_uq" ON "tax_lots" USING btree ("user_id","broker_account_id","lot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "earnings_events_uq" ON "earnings_events" USING btree ("symbol","report_at");--> statement-breakpoint
CREATE INDEX "economic_events_time_idx" ON "economic_events" USING btree ("scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "features_uq" ON "features" USING btree ("symbol","as_of","feature_version");--> statement-breakpoint
CREATE UNIQUE INDEX "market_bars_uq" ON "market_bars" USING btree ("symbol","interval","time","adjusted");--> statement-breakpoint
CREATE INDEX "market_quotes_symbol_time_idx" ON "market_quotes" USING btree ("symbol","received_at");--> statement-breakpoint
CREATE INDEX "market_regimes_time_idx" ON "market_regimes" USING btree ("as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "news_events_hash_uq" ON "news_events" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "news_events_time_idx" ON "news_events" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "signals_key_time_idx" ON "signals" USING btree ("key","as_of");--> statement-breakpoint
CREATE INDEX "signals_symbol_time_idx" ON "signals" USING btree ("symbol","as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_evaluations_uq" ON "candidate_evaluations" USING btree ("user_id","broker_account_id","candidate_id");--> statement-breakpoint
CREATE INDEX "candidates_time_idx" ON "candidates" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "candidates_symbol_idx" ON "candidates" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "predictions_model_time_idx" ON "predictions" USING btree ("model_name","as_of");--> statement-breakpoint
CREATE INDEX "predictions_symbol_idx" ON "predictions" USING btree ("symbol","as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "strategies_key_uq" ON "strategies" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_versions_uq" ON "strategy_versions" USING btree ("strategy_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "user_strategy_settings_uq" ON "user_strategy_settings" USING btree ("user_id","broker_account_id","strategy_id");--> statement-breakpoint
CREATE INDEX "approval_requests_scope_idx" ON "approval_requests" USING btree ("user_id","broker_account_id","status");--> statement-breakpoint
CREATE INDEX "execution_outcomes_scope_idx" ON "execution_outcomes" USING btree ("user_id","broker_account_id","at");--> statement-breakpoint
CREATE INDEX "performance_snapshots_scope_idx" ON "performance_snapshots" USING btree ("user_id","broker_account_id","as_of");--> statement-breakpoint
CREATE INDEX "rejected_trades_scope_idx" ON "rejected_trades" USING btree ("user_id","broker_account_id","rejected_at");--> statement-breakpoint
CREATE INDEX "risk_decisions_scope_idx" ON "risk_decisions" USING btree ("user_id","broker_account_id","decided_at");--> statement-breakpoint
CREATE INDEX "risk_settings_scope_idx" ON "risk_settings" USING btree ("user_id","broker_account_id");--> statement-breakpoint
CREATE INDEX "trade_events_trade_idx" ON "trade_events" USING btree ("trade_id","at");--> statement-breakpoint
CREATE INDEX "trade_theses_scope_idx" ON "trade_theses" USING btree ("user_id","broker_account_id","created_at");--> statement-breakpoint
CREATE INDEX "trade_theses_trade_idx" ON "trade_theses" USING btree ("trade_id");--> statement-breakpoint
CREATE INDEX "trades_scope_idx" ON "trades" USING btree ("user_id","broker_account_id","created_at");--> statement-breakpoint
CREATE INDEX "trades_state_idx" ON "trades" USING btree ("user_id","broker_account_id","state");--> statement-breakpoint
CREATE INDEX "adaptation_proposals_time_idx" ON "adaptation_proposals" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "backtests_strategy_idx" ON "backtests" USING btree ("strategy_key","ran_at");--> statement-breakpoint
CREATE INDEX "learning_digests_idx" ON "learning_digests" USING btree ("period","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "mip_uq" ON "model_intelligence_profiles" USING btree ("model_name","model_version");--> statement-breakpoint
CREATE UNIQUE INDEX "post_trade_reviews_trade_uq" ON "post_trade_reviews" USING btree ("trade_id");--> statement-breakpoint
CREATE INDEX "sip_strategy_idx" ON "strategy_intelligence_profiles" USING btree ("strategy_id","user_id","broker_account_id","mode");--> statement-breakpoint
CREATE INDEX "trade_lessons_strategy_idx" ON "trade_lessons" USING btree ("strategy_key","regime");--> statement-breakpoint
CREATE INDEX "trade_memory_strategy_idx" ON "trade_memory" USING btree ("strategy_key","regime");--> statement-breakpoint
CREATE INDEX "trade_memory_symbol_idx" ON "trade_memory" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "analyst_revisions_idx" ON "analyst_revisions" USING btree ("ticker","as_of");--> statement-breakpoint
CREATE INDEX "catalysts_ticker_idx" ON "catalysts" USING btree ("ticker","expected_date");--> statement-breakpoint
CREATE UNIQUE INDEX "company_profile_history_uq" ON "company_profile_history" USING btree ("ticker","version");--> statement-breakpoint
CREATE INDEX "consensus_snapshots_idx" ON "consensus_snapshots" USING btree ("ticker","as_of");--> statement-breakpoint
CREATE INDEX "expectations_records_idx" ON "expectations_records" USING btree ("ticker","event_at");--> statement-breakpoint
CREATE INDEX "internal_forecasts_idx" ON "internal_forecasts" USING btree ("ticker","as_of");--> statement-breakpoint
CREATE INDEX "variant_views_idx" ON "variant_views" USING btree ("ticker","as_of");--> statement-breakpoint
CREATE INDEX "alerts_scope_idx" ON "alerts" USING btree ("user_id","broker_account_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_time_idx" ON "audit_logs" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_logs_user_idx" ON "audit_logs" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "audit_logs_category_idx" ON "audit_logs" USING btree ("category","at");--> statement-breakpoint
CREATE INDEX "job_runs_name_idx" ON "job_runs" USING btree ("name","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "kill_switches_scope_uq" ON "kill_switches" USING btree ("user_id","broker_account_id");--> statement-breakpoint
CREATE INDEX "model_outputs_time_idx" ON "model_outputs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "model_outputs_agent_idx" ON "model_outputs" USING btree ("agent_name","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "model_registry_uq" ON "model_registry" USING btree ("name","version");--> statement-breakpoint
CREATE INDEX "system_events_time_idx" ON "system_events" USING btree ("at");