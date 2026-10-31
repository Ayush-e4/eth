CREATE TABLE "notify_channels" (
	"user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"link_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notify_channels_user_id_channel_pk" PRIMARY KEY("user_id","channel")
);
--> statement-breakpoint
ALTER TABLE "notify_channels" ADD CONSTRAINT "notify_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;