-- Atlas QA Platform — Enable Supabase Realtime for live status updates
-- This allows the dashboard to receive real-time updates when
-- the Modal runner changes test_run status or inserts test_results.

ALTER PUBLICATION supabase_realtime ADD TABLE test_runs;
ALTER PUBLICATION supabase_realtime ADD TABLE test_results;
