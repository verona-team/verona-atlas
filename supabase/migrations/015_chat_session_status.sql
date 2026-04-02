-- Track persistent agent processing status on chat_sessions so the frontend
-- can show "thinking" even after navigating away and back.
ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'thinking', 'error')),
  ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ DEFAULT now();

-- Enable realtime for chat_sessions so the client can subscribe to status changes.
ALTER PUBLICATION supabase_realtime ADD TABLE chat_sessions;
