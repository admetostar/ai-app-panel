ALTER TABLE "apps" ADD COLUMN "cloned_from_app_id" varchar(512);--> statement-breakpoint
ALTER TABLE "membership_plans" ADD COLUMN "app_clone_limit" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "apps_owner_clone_idx" ON "apps" USING btree ("owner_user_id","cloned_from_app_id");