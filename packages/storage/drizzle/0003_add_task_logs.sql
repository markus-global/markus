-- Add task_logs table for structured task execution progress (audit + live display)
CREATE TABLE IF NOT EXISTS "task_logs" (
  "id" varchar(64) PRIMARY KEY,
  "task_id" varchar(64) NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "agent_id" varchar(64) NOT NULL,
  "seq" integer NOT NULL DEFAULT 0,
  "type" varchar(32) NOT NULL,
  "content" text NOT NULL DEFAULT '',
  "metadata" jsonb DEFAULT '{}',
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_task_logs_task" ON "task_logs" ("task_id", "seq");
