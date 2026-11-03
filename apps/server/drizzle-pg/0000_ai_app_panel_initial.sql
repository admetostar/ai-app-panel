CREATE TABLE "app_acl" (
	"app_id" varchar(512) PRIMARY KEY NOT NULL,
	"allow_group_ids" text DEFAULT '[]' NOT NULL,
	"allow_user_ids" text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_env_vars" (
	"app_id" varchar(512) NOT NULL,
	"name" varchar(191) NOT NULL,
	"value_enc" text NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "app_env_vars_app_id_name_pk" PRIMARY KEY("app_id","name")
);
--> statement-breakpoint
CREATE TABLE "app_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" varchar(191) NOT NULL,
	"user_id" integer,
	"ts" bigint NOT NULL,
	"duration_ms" integer NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"logs" text
);
--> statement-breakpoint
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
CREATE TABLE "apps" (
	"id" varchar(512) PRIMARY KEY NOT NULL,
	"name" varchar(191) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text,
	"category" text DEFAULT '未分类' NOT NULL,
	"visibility" text DEFAULT 'login' NOT NULL,
	"kind" text DEFAULT 'upstream' NOT NULL,
	"owner_user_id" integer,
	"publication_reward_points" integer,
	"manifest_json" text,
	"runtime_mode" text,
	"review_status" text DEFAULT 'none' NOT NULL,
	"review_note" text,
	"submitted_at" bigint,
	"signature_status" text,
	"input_schema" text,
	"pass_user" boolean DEFAULT false NOT NULL,
	"upstream" text NOT NULL,
	"url_secret_enc" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"health_state" text DEFAULT 'unknown' NOT NULL,
	"last_probe_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" bigint NOT NULL,
	"actor" text NOT NULL,
	"ip" varchar(191),
	"action" text NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "invite_codes" (
	"code" varchar(191) PRIMARY KEY NOT NULL,
	"owner_user_id" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ip_bans" (
	"ip" varchar(191) PRIMARY KEY NOT NULL,
	"banned_until" bigint NOT NULL,
	"repeat_count" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_app_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_hash" varchar(191) NOT NULL,
	"app_id" varchar(191) NOT NULL,
	"name" varchar(191) DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"per_minute_limit" integer,
	"auto" boolean DEFAULT false NOT NULL,
	"token_enc" text,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	CONSTRAINT "llm_app_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "llm_balance_cache" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"balance" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" bigint NOT NULL,
	"user_id" integer,
	"app_id" varchar(191),
	"kind" text NOT NULL,
	"model" varchar(191),
	"prompt_tokens" bigint,
	"completion_tokens" bigint,
	"delta" bigint NOT NULL,
	"latency_ms" integer,
	"status" text DEFAULT 'ok' NOT NULL,
	"request_id" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "llm_routes" (
	"id" serial PRIMARY KEY NOT NULL,
	"model" varchar(191) NOT NULL,
	"upstream_id" integer NOT NULL,
	"upstream_model" text NOT NULL,
	"multiplier" integer DEFAULT 100 NOT NULL,
	"cost_per_1k" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"weight" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_upstreams" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(191) NOT NULL,
	"base_url" text NOT NULL,
	"api_key_enc" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_credentials" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"ip" varchar(191) NOT NULL,
	"user_key" varchar(191) NOT NULL,
	"success" boolean NOT NULL,
	"reason" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(191) NOT NULL,
	"group_id" integer NOT NULL,
	"duration_days" integer NOT NULL,
	"price_currency" text DEFAULT 'CNY' NOT NULL,
	"price_fen" integer DEFAULT 0 NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"price_points" integer DEFAULT 0 NOT NULL,
	"redeem_url" text,
	"token_grant" bigint DEFAULT 0 NOT NULL,
	"tier" integer DEFAULT 0 NOT NULL,
	"public_app_limit" integer DEFAULT 10 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "membership_plans_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "oidc_states" (
	"state" varchar(191) PRIMARY KEY NOT NULL,
	"nonce" text NOT NULL,
	"code_verifier" text NOT NULL,
	"ip" varchar(191),
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" varchar(512) PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" text,
	"device_type" text,
	"backedUp" boolean DEFAULT false NOT NULL,
	"nickname" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint
);
--> statement-breakpoint
CREATE TABLE "pow_challenges" (
	"id" varchar(512) PRIMARY KEY NOT NULL,
	"seed" text NOT NULL,
	"difficulty" integer NOT NULL,
	"ip" varchar(191) NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pow_tokens" (
	"token" varchar(191) PRIMARY KEY NOT NULL,
	"ip" varchar(191) NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redeem_codes" (
	"code" varchar(191) PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"kind" text NOT NULL,
	"tokens" bigint,
	"plan_id" integer,
	"status" text DEFAULT 'unused' NOT NULL,
	"note" text,
	"expires_at" bigint,
	"created_by" integer,
	"created_at" bigint NOT NULL,
	"used_by" integer,
	"used_at" bigint
);
--> statement-breakpoint
CREATE TABLE "registrations" (
	"id" varchar(512) PRIMARY KEY NOT NULL,
	"username" varchar(191) NOT NULL,
	"password_hash" text NOT NULL,
	"email" varchar(320),
	"phone" varchar(191),
	"invite_code" text,
	"ip" varchar(191),
	"attempts" integer DEFAULT 0 NOT NULL,
	"completed_at" bigint,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_hash" varchar(191) NOT NULL,
	"user_id" integer NOT NULL,
	"auth_state" text DEFAULT 'full' NOT NULL,
	"step_up_until" bigint,
	"created_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"ip" varchar(191),
	"user_agent" text,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" varchar(191) PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topup_orders" (
	"id" varchar(512) PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"plan_id" integer,
	"tokens" bigint,
	"price_currency" text DEFAULT 'CNY' NOT NULL,
	"price_fen" integer NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"channel" varchar(191) DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"created_at" bigint NOT NULL,
	"paid_at" bigint
);
--> statement-breakpoint
CREATE TABLE "totp_secrets" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"secret_enc" text NOT NULL,
	"last_used_counter" integer DEFAULT -1 NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trusted_signing_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"key_id" varchar(191) NOT NULL,
	"name" varchar(191) DEFAULT '' NOT NULL,
	"public_key" text NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "trusted_signing_keys_key_id_unique" UNIQUE("key_id")
);
--> statement-breakpoint
CREATE TABLE "user_group_members" (
	"group_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "user_group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "user_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(191) NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"app_publish_reward_points" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "user_groups_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'local' NOT NULL,
	"username" varchar(191),
	"subject" varchar(191),
	"email" varchar(320),
	"phone" varchar(191),
	"name" varchar(191) DEFAULT '' NOT NULL,
	"avatar" text,
	"role" text DEFAULT 'user' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"membership_plan_id" integer,
	"membership_expires_at" bigint,
	"points_balance" integer DEFAULT 0 NOT NULL,
	"membership_selection_required" boolean DEFAULT false NOT NULL,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"deletion_requested_at" bigint,
	"created_at" bigint NOT NULL,
	"last_login_at" bigint,
	"last_ip" text
);
--> statement-breakpoint
CREATE TABLE "verification_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel" varchar(191) NOT NULL,
	"target" varchar(320) NOT NULL,
	"purpose" text NOT NULL,
	"code_hash" text NOT NULL,
	"ip" varchar(191),
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"consumed_at" bigint
);
--> statement-breakpoint
ALTER TABLE "app_acl" ADD CONSTRAINT "app_acl_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_env_vars" ADD CONSTRAINT "app_env_vars_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_routes" ADD CONSTRAINT "llm_routes_upstream_id_llm_upstreams_id_fk" FOREIGN KEY ("upstream_id") REFERENCES "llm_upstreams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_credentials" ADD CONSTRAINT "local_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_plans" ADD CONSTRAINT "membership_plans_group_id_user_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "user_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topup_orders" ADD CONSTRAINT "topup_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "totp_secrets" ADD CONSTRAINT "totp_secrets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_group_id_user_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "user_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_runs_app_idx" ON "app_runs" USING btree ("app_id","ts");--> statement-breakpoint
CREATE INDEX "app_runtime_events_ts_idx" ON "app_runtime_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "app_runtime_events_app_ts_idx" ON "app_runtime_events" USING btree ("app_id","ts");--> statement-breakpoint
CREATE INDEX "audit_logs_ts_idx" ON "audit_logs" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_codes_owner_user_id_uq" ON "invite_codes" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "llm_tokens_app_idx" ON "llm_app_tokens" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "llm_ledger_user_idx" ON "llm_ledger" USING btree ("user_id","ts");--> statement-breakpoint
CREATE INDEX "llm_ledger_app_idx" ON "llm_ledger" USING btree ("app_id","ts");--> statement-breakpoint
CREATE INDEX "llm_routes_model_idx" ON "llm_routes" USING btree ("model");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_idx" ON "login_attempts" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "login_attempts_user_idx" ON "login_attempts" USING btree ("user_key","created_at");--> statement-breakpoint
CREATE INDEX "passkeys_user_idx" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recovery_codes_user_idx" ON "recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "registrations_created_idx" ON "registrations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "topup_orders_user_idx" ON "topup_orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_uq" ON "users" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email") WHERE email IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_uq" ON "users" USING btree ("phone") WHERE phone IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_subject_uq" ON "users" USING btree ("subject") WHERE subject IS NOT NULL;--> statement-breakpoint
CREATE INDEX "verification_codes_target_idx" ON "verification_codes" USING btree ("channel","target","created_at");