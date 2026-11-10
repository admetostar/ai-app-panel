ALTER TABLE "apps" ADD COLUMN "anonymous_access" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "anonymous_access_policy" text DEFAULT 'manifest' NOT NULL;--> statement-breakpoint
UPDATE "apps" SET "anonymous_access" = 'write', "anonymous_access_policy" = 'legacy' WHERE "visibility" = 'public';