-- Add live_session JSONB column to test_runs for tracking the active Browserbase
-- browser session. Populated by the runner while a template is executing so the
-- frontend can embed a live view iframe. Cleared when the template finishes.
ALTER TABLE public.test_runs ADD COLUMN live_session JSONB;

COMMENT ON COLUMN public.test_runs.live_session IS
  'Active Browserbase session info: { browserbase_session_id, template_name, template_id, started_at }';
