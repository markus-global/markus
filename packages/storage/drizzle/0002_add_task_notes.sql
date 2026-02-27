-- Add notes column to tasks table for persistent task notes
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "notes" jsonb DEFAULT '[]';
