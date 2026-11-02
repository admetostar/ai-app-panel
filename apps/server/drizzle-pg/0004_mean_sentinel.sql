CREATE TABLE "app_runtime_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" varchar(191) NOT NULL,
	"ts" bigint NOT NULL,
	"level" text NOT NULL,
	"event" varchar(64) NOT NULL,
	"user_id" integer,
	"method" varchar(16),
	"path" varchar(512),
	"status_code" integer,
	"duration_ms" integer,
	"details" text
);
--> statement-breakpoint
CREATE INDEX "app_runtime_events_ts_idx" ON "app_runtime_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "app_runtime_events_app_ts_idx" ON "app_runtime_events" USING btree ("app_id","ts");