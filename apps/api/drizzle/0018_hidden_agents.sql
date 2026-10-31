CREATE TABLE "hidden_agents" (
	"agent" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"reason" text NOT NULL,
	"hidden_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hidden_agents" ADD CONSTRAINT "hidden_agents_hidden_by_users_id_fk" FOREIGN KEY ("hidden_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;