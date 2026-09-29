CREATE TABLE "app_secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"envelope" text NOT NULL,
	"hint" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
