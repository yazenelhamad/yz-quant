CREATE TABLE "survival_states" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"mode" text NOT NULL,
	"mode_since" timestamp with time zone NOT NULL,
	"previous_mode" text,
	"fitness_score" double precision NOT NULL,
	"risk_multiplier" double precision NOT NULL,
	"min_edge_multiplier" double precision NOT NULL,
	"hurdle_bps" double precision NOT NULL,
	"max_new_positions" integer NOT NULL,
	"allow_live_entries" boolean NOT NULL,
	"runway_days" double precision,
	"alpha_pct" double precision,
	"state" jsonb NOT NULL,
	"version" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "survival_states_scope_idx" ON "survival_states" USING btree ("user_id","broker_account_id","computed_at");
