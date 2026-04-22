-- Landing page "communal museum" — generated images + global 1-per-hour lock.
--
-- Requirements:
--   * Users submit name + prompt (location derived from IP on the server).
--   * Only one generation allowed per hour, globally.
--   * If many users submit simultaneously, exactly one request wins.
--   * Public read access so the landing page can display all past generations
--     without requiring auth.

CREATE TABLE IF NOT EXISTS public.landing_generated_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  location TEXT,
  image_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS landing_generated_images_created_at_idx
  ON public.landing_generated_images (created_at DESC);

-- Singleton lock row. We use a single fixed-id row so that the atomic
-- acquisition function can target it with a predictable WHERE clause.
CREATE TABLE IF NOT EXISTS public.landing_generation_lock (
  id INT PRIMARY KEY CHECK (id = 1),
  lock_expires_at TIMESTAMPTZ,           -- when the current lock releases (for concurrency control)
  next_allowed_at TIMESTAMPTZ,           -- when the next generation is allowed (for UI timer)
  locked_by UUID                          -- opaque token issued to the winning request
);

INSERT INTO public.landing_generation_lock (id, lock_expires_at, next_allowed_at, locked_by)
VALUES (1, NULL, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- Atomically attempt to acquire the generation lock.
--
-- Returns a UUID "token" if the caller has acquired the lock.
-- Returns NULL if another request currently holds the lock OR if the cooldown
-- window from the last successful generation has not yet elapsed.
--
-- The lock auto-expires after p_lock_duration_seconds so a crashed request
-- can't hold the lock forever. On successful generation, the caller calls
-- commit_landing_lock() to set the post-generation cooldown window.
CREATE OR REPLACE FUNCTION public.try_acquire_landing_lock(
  p_lock_duration_seconds INT DEFAULT 120
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token UUID := gen_random_uuid();
  v_updated_token UUID;
BEGIN
  UPDATE public.landing_generation_lock
  SET
    lock_expires_at = now() + make_interval(secs => p_lock_duration_seconds),
    locked_by = v_token
  WHERE id = 1
    AND (lock_expires_at IS NULL OR lock_expires_at < now())
    AND (next_allowed_at IS NULL OR next_allowed_at <= now())
  RETURNING locked_by INTO v_updated_token;

  RETURN v_updated_token;
END;
$$;

-- Commit the lock after a successful generation: clears the in-flight lock and
-- sets the next_allowed_at cooldown window (default 1 hour).
CREATE OR REPLACE FUNCTION public.commit_landing_lock(
  p_token UUID,
  p_cooldown_seconds INT DEFAULT 3600
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows INT;
BEGIN
  UPDATE public.landing_generation_lock
  SET
    lock_expires_at = NULL,
    locked_by = NULL,
    next_allowed_at = now() + make_interval(secs => p_cooldown_seconds)
  WHERE id = 1 AND locked_by = p_token;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- Release the lock without setting a cooldown (used when generation fails,
-- so the next user can immediately try again).
CREATE OR REPLACE FUNCTION public.release_landing_lock(p_token UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows INT;
BEGIN
  UPDATE public.landing_generation_lock
  SET
    lock_expires_at = NULL,
    locked_by = NULL
  WHERE id = 1 AND locked_by = p_token;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.try_acquire_landing_lock(INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_landing_lock(UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_landing_lock(UUID) TO service_role;

-- RLS: the landing page is public, so we allow anon + authenticated SELECT.
-- All writes go through the server (service role), which bypasses RLS.
ALTER TABLE public.landing_generated_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_generation_lock ENABLE ROW LEVEL SECURITY;

CREATE POLICY landing_generated_images_public_read
  ON public.landing_generated_images
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY landing_generation_lock_public_read
  ON public.landing_generation_lock
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Storage bucket for the generated PNGs. Public so <img> tags work directly.
INSERT INTO storage.buckets (id, name, public)
VALUES ('landing-images', 'landing-images', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Public can view landing images"
  ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'landing-images');

CREATE POLICY "Service role can upload landing images"
  ON storage.objects FOR INSERT
  TO service_role
  WITH CHECK (bucket_id = 'landing-images');
