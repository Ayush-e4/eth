CREATE TABLE "passkey_wallets" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"passkey_id" text NOT NULL,
	"address" text NOT NULL,
	"hedera_id" text,
	"status" text DEFAULT 'creating' NOT NULL,
	"gift_units" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "passkey_wallets" ADD CONSTRAINT "passkey_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;