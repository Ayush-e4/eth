CREATE TABLE "approvals" (
	"chat_id" uuid NOT NULL,
	"code" text NOT NULL,
	"ref" text NOT NULL,
	"agent" text NOT NULL,
	"fee_units" bigint NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"human_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_chat_id_code_pk" PRIMARY KEY("chat_id","code")
);
--> statement-breakpoint
CREATE TABLE "human_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"code" text NOT NULL,
	"user_code" text NOT NULL,
	"link" text NOT NULL,
	"device_code" text NOT NULL,
	"interval_s" integer NOT NULL,
	"started_at_s" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "open_tasks" (
	"task" text PRIMARY KEY NOT NULL,
	"chat_id" uuid NOT NULL,
	"entity_key" text NOT NULL,
	"skill" text NOT NULL,
	"input" jsonb NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"awarded" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_refs" (
	"n" serial PRIMARY KEY NOT NULL,
	"chat_id" uuid NOT NULL,
	"task" text NOT NULL,
	"option_key" text NOT NULL,
	"round" jsonb NOT NULL,
	"option" jsonb NOT NULL,
	"held_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_payments" (
	"schedule_id" text PRIMARY KEY NOT NULL,
	"chat_id" uuid NOT NULL,
	"payment_key" text NOT NULL,
	"executes_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_checks" ADD CONSTRAINT "human_checks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_checks" ADD CONSTRAINT "human_checks_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_tasks" ADD CONSTRAINT "open_tasks_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_refs" ADD CONSTRAINT "quote_refs_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_payments" ADD CONSTRAINT "scheduled_payments_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quote_refs_chat_idx" ON "quote_refs" USING btree ("chat_id","held_at");