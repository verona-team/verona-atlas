-- Add research_report column to chat_sessions for caching the research agent output
ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS research_report JSONB;
