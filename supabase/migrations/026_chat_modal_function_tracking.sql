-- Track the in-flight Modal FunctionCall for a chat session's active turn.
-- Chat turns now execute inside a Modal Python worker (process_chat_turn)
-- rather than inside the Next.js /api/chat route handler, so we need a
-- durable pointer to "which background job is this turn running under" for:
--
--   1. Duplicate-POST dedup. If the user sends the same client_message_id
--      twice (e.g. via a hard refresh re-firing the bootstrap effect), the
--      second POST observes the active call and short-circuits instead of
--      spawning a second Modal invocation.
--   2. Future cancel support (modal.FunctionCall(id).cancel()).
--   3. Observability — given a stuck "thinking" session we can jump straight
--      to the Modal invocation logs.
--
-- active_chat_call_started_at is the sanity anchor: if a session has been
-- "thinking" for longer than the Modal function's maxDuration (~1h), the
-- call is dead and a new POST is allowed to spawn a fresh one.

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS active_chat_call_id TEXT,
  ADD COLUMN IF NOT EXISTS active_chat_call_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_active_call
  ON chat_sessions(active_chat_call_id)
  WHERE active_chat_call_id IS NOT NULL;
