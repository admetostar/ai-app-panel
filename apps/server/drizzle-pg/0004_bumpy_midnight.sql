CREATE TABLE "llm_chat_jobs" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"app_id" varchar(191) NOT NULL,
	"user_id" integer,
	"model" varchar(191) NOT NULL,
	"status" varchar(24) NOT NULL,
	"stage" varchar(32) NOT NULL,
	"result_json" text,
	"error" text,
	"timings_json" text DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_media_files" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"app_id" varchar(191) NOT NULL,
	"user_id" integer,
	"filename" text NOT NULL,
	"mime_type" varchar(127) NOT NULL,
	"size" bigint NOT NULL,
	"upload_ms" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_routes" ADD COLUMN "media_adapter" text DEFAULT 'image_url' NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_chat_jobs" ADD CONSTRAINT "llm_chat_jobs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_chat_jobs" ADD CONSTRAINT "llm_chat_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_media_files" ADD CONSTRAINT "llm_media_files_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_media_files" ADD CONSTRAINT "llm_media_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_chat_jobs_app_expiry_idx" ON "llm_chat_jobs" USING btree ("app_id","expires_at");--> statement-breakpoint
CREATE INDEX "llm_chat_jobs_user_idx" ON "llm_chat_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_media_app_expiry_idx" ON "llm_media_files" USING btree ("app_id","expires_at");--> statement-breakpoint
CREATE INDEX "llm_media_user_idx" ON "llm_media_files" USING btree ("user_id","created_at");