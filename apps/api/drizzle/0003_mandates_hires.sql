CREATE TABLE "hires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"mandate_id" bigint NOT NULL,
	"skill" text NOT NULL,
	"agent" text NOT NULL,
	"title" text NOT NULL,
	"fee_units" bigint NOT NULL,
	"hedera_tx" text NOT NULL,
	"job_key" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"mandate_id" bigint NOT NULL,
	"owner" text NOT NULL,
	"payer" text NOT NULL,
	"budget_units" bigint NOT NULL,
	"payees" jsonb NOT NULL,
	"demo" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hires" ADD CONSTRAINT "hires_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hires_chat_idx" ON "hires" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "mandates_chat_idx" ON "mandates" USING btree ("chat_id","created_at");