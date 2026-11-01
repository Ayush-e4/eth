ALTER TABLE "passkey_wallets" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "passkeys" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "passkeys" ADD COLUMN "on_wallet" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Each existing wallet already answers to the passkey that made it.
UPDATE "passkeys" SET "on_wallet" = true WHERE "id" IN (SELECT "passkey_id" FROM "passkey_wallets");
