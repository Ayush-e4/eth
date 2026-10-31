CREATE TABLE "pending_hires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"mandate_id" bigint NOT NULL,
	"payer" text NOT NULL,
	"endpoint" text NOT NULL,
	"quote_key" text NOT NULL,
	"round" jsonb NOT NULL,
	"option" jsonb NOT NULL,
	"delegation" jsonb,
	"label" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_hires" ADD CONSTRAINT "pending_hires_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;