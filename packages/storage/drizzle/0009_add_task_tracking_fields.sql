-- Add creator/updater tracking and timestamp fields to tasks
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "created_by" varchar(128);
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "updated_by" varchar(128);
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "started_at" timestamp;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "completed_at" timestamp;
