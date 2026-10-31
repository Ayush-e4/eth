-- MandateRegistry v2 numbers limits from 1 again, so each limit and hire records its registry (lowercase).
-- Everything saved before this lives on v1.
ALTER TABLE "hires" ADD COLUMN "registry" text NOT NULL DEFAULT '0x2f30e8f1804fe163c76918db493a441d44394d5d';--> statement-breakpoint
ALTER TABLE "hires" ALTER COLUMN "registry" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "registry" text NOT NULL DEFAULT '0x2f30e8f1804fe163c76918db493a441d44394d5d';--> statement-breakpoint
ALTER TABLE "mandates" ALTER COLUMN "registry" DROP DEFAULT;
