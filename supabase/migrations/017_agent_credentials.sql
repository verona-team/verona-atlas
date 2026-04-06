-- Agent-managed credentials: the QA browser agent creates its own accounts
-- on target platforms and stores the credentials here for reuse across runs.

CREATE TABLE public.agent_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  password_encrypted TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX agent_credentials_project_id_idx ON public.agent_credentials (project_id);

CREATE TRIGGER agent_credentials_set_updated_at
  BEFORE UPDATE ON public.agent_credentials
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

-- RLS: agent_credentials are only accessed by the service role (Modal runner).
-- Enable RLS and add a select policy scoped through the project's org so
-- dashboard users can view (but not modify) credential status.
ALTER TABLE public.agent_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_credentials_select
  ON public.agent_credentials
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = agent_credentials.project_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  );

-- Drop user-provided credential columns from projects (agent creates its own now)
ALTER TABLE public.projects DROP COLUMN IF EXISTS auth_email;
ALTER TABLE public.projects DROP COLUMN IF EXISTS auth_password_encrypted;
