CREATE TABLE "fare_watches" (
	"watch_id" text PRIMARY KEY NOT NULL,
	"chat_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"endpoint" text NOT NULL,
	"input" jsonb NOT NULL,
	"alerts_seen" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'watching' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fare_watches" ADD CONSTRAINT "fare_watches_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;