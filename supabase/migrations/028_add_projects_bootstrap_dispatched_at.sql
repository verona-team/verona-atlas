-- Track whether the initial "bootstrap" chat turn has been dispatched for a
-- project.
--
-- Background: when a user creates a new project, the chat UI fires an
-- auto-bootstrap message ("I just set up X. Analyze my project data...") on
-- first visit to an empty thread (`ChatInterface` useEffect in
-- `components/chat/chat-interface.tsx`). This was happening whenever the user
-- closed the new-project modal after connecting GitHub, even if they were
-- still in the middle of connecting other integrations, which is a confusing
-- UX — the agent started processing before the user was done setting up.
--
-- The new flow defers that message: closing the modal mid-setup routes the
-- user to a CTA landing for the new project (embedded integration cards +
-- an explicit "Continue to chat" button). Only when the user clicks Continue
-- (or clicks the modal's own Continue button) do we flip this column and let
-- the bootstrap effect fire.
--
-- NULL  = user has not armed the agent yet → render CTA in place of chat.
-- non-NULL = bootstrap has been dispatched (or this project predates deferral)
--            → render chat normally; bootstrap effect may fire if empty.
--
-- No backfill: the database is empty prior to shipping this change, so every
-- project created from here on starts with NULL and gets the new CTA flow.

alter table public.projects
  add column bootstrap_dispatched_at timestamptz;
