UPDATE "apps" SET "visibility" = 'login' WHERE "visibility" = 'restricted';--> statement-breakpoint
DROP TABLE "app_acl" CASCADE;