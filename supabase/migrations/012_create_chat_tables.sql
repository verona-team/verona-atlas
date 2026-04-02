-- Extend run_trigger enum with scheduled and chat values
ALTER TYPE run_trigger ADD VALUE IF NOT EXISTS 'scheduled';
ALTER TYPE run_trigger ADD VALUE IF NOT EXISTS 'chat';

-- Extend template_source enum
ALTER TYPE template_source ADD VALUE IF NOT EXISTS 'chat_generated';

-- Add schedule + timezone columns to projects
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'America/New_York',
  ADD COLUMN IF NOT EXISTS schedule_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS schedule_time TIME DEFAULT '21:00',
  ADD COLUMN IF NOT EXISTS schedule_days TEXT[] DEFAULT ARRAY['mon','tue','wed','thu','fri'];

-- Chat sessions (one per project)
CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  context_summary TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id)
);

-- Chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created
  ON chat_messages(session_id, created_at);

-- Add recording_url to test_results
ALTER TABLE test_results
  ADD COLUMN IF NOT EXISTS recording_url TEXT;
