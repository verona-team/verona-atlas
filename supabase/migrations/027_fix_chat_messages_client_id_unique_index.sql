-- Fix the `(session_id, client_message_id)` unique index so it can serve as
-- an `ON CONFLICT` target for PostgREST upserts.
--
-- Migration 022 created this as a PARTIAL unique index:
--
--   CREATE UNIQUE INDEX idx_chat_messages_session_client_id
--     ON chat_messages(session_id, client_message_id)
--     WHERE client_message_id IS NOT NULL;
--
-- The predicate was intended to permit multiple rows with
-- `client_message_id = NULL` (tool-inserted rows like flow_proposals /
-- test_run_started that have no stream id). That part works.
--
-- The problem is that PostgREST's upsert flow cannot use a PARTIAL index
-- as the ON CONFLICT target. It passes `on_conflict=session_id,client_message_id`
-- as a bare column list with no predicate, and Postgres then refuses with
--
--   ERROR 42P10: there is no unique or exclusion constraint matching the
--                ON CONFLICT specification
--
-- Every upsert in the chat path (`/api/chat` user-message persist,
-- `runner/chat/nodes.finalize` assistant-message persist) fails because
-- of this. Reproduced live against the remote DB with both supabase-js and
-- supabase-py using the exact upsert call from those call sites.
--
-- Fix: drop the partial predicate. A plain unique index on
-- `(session_id, client_message_id)` still permits multiple NULLs per
-- session because Postgres' default B-tree semantics treat NULLs as
-- distinct — so the constraint behavior is identical for the non-null
-- rows we actually care about, but now PostgREST can upsert against it.
--
-- If we ever needed to forbid duplicate NULLs we would add
-- `NULLS NOT DISTINCT` (PG15+); we intentionally do NOT want that here.

DROP INDEX IF EXISTS idx_chat_messages_session_client_id;

CREATE UNIQUE INDEX idx_chat_messages_session_client_id
  ON chat_messages(session_id, client_message_id);
