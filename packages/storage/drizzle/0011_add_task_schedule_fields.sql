ALTER TABLE "tasks" ADD COLUMN "task_type" varchar(16) NOT NULL DEFAULT 'standard';
ALTER TABLE "tasks" ADD COLUMN "schedule_config" jsonb;
