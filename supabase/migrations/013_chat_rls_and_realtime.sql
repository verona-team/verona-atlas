-- RLS for chat_sessions
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can access chat sessions for their org projects"
  ON chat_sessions FOR ALL
  USING (project_id IN (
    SELECT p.id FROM projects p
    WHERE p.org_id IN (SELECT get_user_org_ids())
  ));

-- Service role bypass for cron jobs
CREATE POLICY "Service role full access to chat_sessions"
  ON chat_sessions FOR ALL
  USING (current_setting('role') = 'service_role');

-- RLS for chat_messages
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can access messages in their chat sessions"
  ON chat_messages FOR ALL
  USING (session_id IN (
    SELECT cs.id FROM chat_sessions cs
    JOIN projects p ON cs.project_id = p.id
    WHERE p.org_id IN (SELECT get_user_org_ids())
  ));

CREATE POLICY "Service role full access to chat_messages"
  ON chat_messages FOR ALL
  USING (current_setting('role') = 'service_role');

-- Enable realtime for chat_messages
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;

-- Create storage bucket for test recordings
INSERT INTO storage.buckets (id, name, public)
VALUES ('test-recordings', 'test-recordings', true)
ON CONFLICT (id) DO NOTHING;
