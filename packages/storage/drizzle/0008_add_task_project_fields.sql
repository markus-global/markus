-- Add project_id and iteration_id columns to tasks table
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "project_id" varchar(64);
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "iteration_id" varchar(64);
