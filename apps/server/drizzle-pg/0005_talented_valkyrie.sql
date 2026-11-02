ALTER TABLE "apps" ADD COLUMN "publication_reward_points" integer;--> statement-breakpoint
ALTER TABLE "user_groups" ADD COLUMN "app_publish_reward_points" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "apps" SET "publication_reward_points" = 0 WHERE "visibility" = 'public';