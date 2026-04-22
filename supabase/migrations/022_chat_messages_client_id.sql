-- Dedup assistant/user messages between Realtime DB rows and the AI SDK
-- useChat in-flight stream by storing the stream's UIMessage id. The client
-- dedup becomes a pure id equality check (streamMsg.id === db.client_message_id)
-- instead of fuzzy text comparison.
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS client_message_id TEXT;

-- One DB row per client id per session. NULL allowed so tool-inserted rows
-- (flow_proposals, test_run_started) without a matching stream message are fine.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_session_client_id
  ON chat_messages(session_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
