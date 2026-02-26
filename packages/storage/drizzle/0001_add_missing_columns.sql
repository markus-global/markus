-- Add agent_role to agents table
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "agent_role" varchar(16) NOT NULL DEFAULT 'worker';

-- Add manager_id and manager_type to teams table
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "manager_id" varchar(64);
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "manager_type" varchar(16);

-- Add team_id to users table
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "team_id" varchar(64);
