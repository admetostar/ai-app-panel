ALTER TABLE "membership_plans" ADD COLUMN "price_currency" text DEFAULT 'CNY' NOT NULL;--> statement-breakpoint
ALTER TABLE "membership_plans" ADD COLUMN "price_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "membership_plans" ADD COLUMN "price_points" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "topup_orders" ADD COLUMN "price_currency" text DEFAULT 'CNY' NOT NULL;--> statement-breakpoint
ALTER TABLE "topup_orders" ADD COLUMN "price_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "points_balance" integer DEFAULT 0 NOT NULL;