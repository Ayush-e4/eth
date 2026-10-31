ALTER TABLE "users" ADD COLUMN "world_iss" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "world_sub" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_world_idx" ON "users" USING btree ("world_iss","world_sub");