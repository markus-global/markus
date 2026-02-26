CREATE TYPE "public"."agent_status" AS ENUM('idle', 'working', 'paused', 'offline', 'error');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_platform" AS ENUM('feishu', 'whatsapp', 'slack', 'telegram', 'webui', 'internal');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'assigned', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "agent_channel_bindings" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"agent_id" varchar(64) NOT NULL,
	"platform" varchar(32) NOT NULL,
	"channel_id" varchar(255) NOT NULL,
	"role" varchar(32) DEFAULT 'member' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"org_id" varchar(64) NOT NULL,
	"team_id" varchar(64),
	"role_id" varchar(64) NOT NULL,
	"role_name" varchar(255) NOT NULL,
	"status" "agent_status" DEFAULT 'offline' NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb,
	"llm_config" jsonb DEFAULT '{}'::jsonb,
	"compute_config" jsonb DEFAULT '{}'::jsonb,
	"channels" jsonb DEFAULT '[]'::jsonb,
	"heartbeat_interval_ms" integer DEFAULT 1800000 NOT NULL,
	"container_id" varchar(128),
	"tokens_used_today" integer DEFAULT 0 NOT NULL,
	"last_heartbeat" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_messages" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"org_id" varchar(64) NOT NULL,
	"channel" varchar(128) NOT NULL,
	"sender_id" varchar(255) NOT NULL,
	"sender_type" varchar(16) NOT NULL,
	"sender_name" varchar(255) NOT NULL,
	"text" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"session_id" varchar(64) NOT NULL,
	"agent_id" varchar(64) NOT NULL,
	"role" varchar(32) NOT NULL,
	"content" text NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"agent_id" varchar(64) NOT NULL,
	"user_id" varchar(255),
	"title" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_message_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"agent_id" varchar(64) NOT NULL,
	"type" varchar(32) NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"platform" "message_platform" NOT NULL,
	"direction" "message_direction" NOT NULL,
	"channel_id" varchar(255) NOT NULL,
	"sender_id" varchar(255) NOT NULL,
	"sender_name" varchar(255),
	"agent_id" varchar(64),
	"content" jsonb NOT NULL,
	"reply_to_id" varchar(255),
	"thread_id" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"plan" varchar(32) DEFAULT 'free' NOT NULL,
	"max_agents" integer DEFAULT 5 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"org_id" varchar(64) NOT NULL,
	"title" varchar(500) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"priority" "task_priority" DEFAULT 'medium' NOT NULL,
	"execution_mode" varchar(32),
	"assigned_agent_id" varchar(64),
	"parent_task_id" varchar(64),
	"result" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"due_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"org_id" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"lead_agent_id" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"org_id" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255),
	"role" varchar(32) DEFAULT 'member' NOT NULL,
	"password_hash" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_login_at" timestamp,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "agent_channel_bindings" ADD CONSTRAINT "agent_channel_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_agent_id_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_channel_messages_channel" ON "channel_messages" USING btree ("channel","created_at");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_session" ON "chat_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_chat_sessions_agent" ON "chat_sessions" USING btree ("agent_id","last_message_at");