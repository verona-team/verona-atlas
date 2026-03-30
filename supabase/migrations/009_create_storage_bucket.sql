-- Atlas QA Platform — Storage bucket for test screenshots
-- Note: This must be run via Supabase dashboard or CLI since
-- storage bucket creation requires the storage schema.

-- Create the bucket for test screenshots
INSERT INTO storage.buckets (id, name, public)
VALUES ('test-screenshots', 'test-screenshots', true)
ON CONFLICT (id) DO NOTHING;

-- Policy: Allow authenticated users to read screenshots
CREATE POLICY "Authenticated users can view screenshots"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'test-screenshots');

-- Policy: Allow service role to upload screenshots (Modal runner)
-- The service role key bypasses RLS, so this is mainly for documentation.
-- If needed, add explicit policy:
CREATE POLICY "Service role can upload screenshots"
ON storage.objects FOR INSERT
TO service_role
WITH CHECK (bucket_id = 'test-screenshots');

CREATE POLICY "Service role can update screenshots"
ON storage.objects FOR UPDATE
TO service_role
USING (bucket_id = 'test-screenshots');
