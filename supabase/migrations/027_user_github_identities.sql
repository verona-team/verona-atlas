-- Per-Verona-user GitHub OAuth identity + tokens.
--
-- Populated by /api/integrations/github/callback after a successful
-- OAuth-during-install round-trip. Enables:
--
--   1. Safe auto-linking of GitHub App installations via
--      GET /user/installations (scoped to the authenticated GitHub user
--      by the OAuth token — never a cross-tenant leak).
--   2. Future UX: "Linked by @octocat", re-using the token across projects
--      in the same Verona user's orgs, etc.
--
-- Tokens are AES-256-GCM encrypted at rest using the shared ENCRYPTION_KEY
-- env var (see lib/encryption.ts). Never stored or logged in plaintext.

CREATE TABLE public.user_github_identities (
  user_id UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  github_user_id BIGINT NOT NULL,
  github_login TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX user_github_identities_github_user_id_idx
  ON public.user_github_identities (github_user_id);

CREATE TRIGGER user_github_identities_set_updated_at
  BEFORE UPDATE ON public.user_github_identities
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.user_github_identities ENABLE ROW LEVEL SECURITY;

-- Users can read their own identity row (e.g. to show "Connected as @octocat"
-- in the settings UI). Writes go through the service role from the callback
-- handler — no INSERT/UPDATE policy for authenticated users.
CREATE POLICY user_github_identities_select_own
  ON public.user_github_identities
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());
