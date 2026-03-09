-- Add blocked_by dependency tracking to tasks
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "blocked_by" jsonb DEFAULT '[]'::jsonb;
