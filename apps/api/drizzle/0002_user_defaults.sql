ALTER TABLE "users" ADD COLUMN "default_mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "default_limit_units" bigint DEFAULT 300000 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "onboarded_at" timestamp with time zone;