ALTER TABLE "apps" ADD COLUMN "app_alias" varchar(63);--> statement-breakpoint
CREATE UNIQUE INDEX "apps_alias_uq" ON "apps" USING btree ("app_alias") WHERE "apps"."app_alias" IS NOT NULL;