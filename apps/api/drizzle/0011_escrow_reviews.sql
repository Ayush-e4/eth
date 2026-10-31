CREATE TABLE "escrow_reviews" (
	"escrow_id" text PRIMARY KEY NOT NULL,
	"chat_id" uuid NOT NULL,
	"title" text NOT NULL,
	"release_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'holding' NOT NULL,
	"released_tx" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "escrow_reviews" ADD CONSTRAINT "escrow_reviews_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;