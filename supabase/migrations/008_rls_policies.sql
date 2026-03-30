-- Atlas QA Platform - Row Level Security
-- The Supabase service role key (used by the Modal runner and other backend jobs) bypasses RLS.

CREATE OR REPLACE FUNCTION public.get_user_org_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT om.org_id
  FROM public.org_members om
  WHERE om.user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_org_owner(target_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.org_members om
    WHERE om.user_id = auth.uid()
      AND om.org_id = target_org_id
      AND om.role = 'owner'::org_role
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_user_org_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_org_owner(UUID) TO authenticated;

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_results ENABLE ROW LEVEL SECURITY;

-- organizations
CREATE POLICY organizations_select_member
  ON public.organizations
  FOR SELECT
  TO authenticated
  USING (id IN (SELECT public.get_user_org_ids()));

CREATE POLICY organizations_insert_authenticated
  ON public.organizations
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY organizations_update_owner
  ON public.organizations
  FOR UPDATE
  TO authenticated
  USING (public.is_org_owner(id))
  WITH CHECK (public.is_org_owner(id));

CREATE POLICY organizations_delete_owner
  ON public.organizations
  FOR DELETE
  TO authenticated
  USING (public.is_org_owner(id));

-- org_members
CREATE POLICY org_members_select
  ON public.org_members
  FOR SELECT
  TO authenticated
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY org_members_insert
  ON public.org_members
  FOR INSERT
  TO authenticated
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY org_members_update
  ON public.org_members
  FOR UPDATE
  TO authenticated
  USING (org_id IN (SELECT public.get_user_org_ids()))
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY org_members_delete
  ON public.org_members
  FOR DELETE
  TO authenticated
  USING (org_id IN (SELECT public.get_user_org_ids()));

-- projects
CREATE POLICY projects_select
  ON public.projects
  FOR SELECT
  TO authenticated
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY projects_insert
  ON public.projects
  FOR INSERT
  TO authenticated
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY projects_update
  ON public.projects
  FOR UPDATE
  TO authenticated
  USING (org_id IN (SELECT public.get_user_org_ids()))
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY projects_delete
  ON public.projects
  FOR DELETE
  TO authenticated
  USING (org_id IN (SELECT public.get_user_org_ids()));

-- integrations (via project org)
CREATE POLICY integrations_select
  ON public.integrations
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = integrations.project_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  );

CREATE POLICY integrations_insert
  ON public.integrations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  );

CREATE POLICY integrations_update
  ON public.integrations
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = integrations.project_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  );

CREATE POLICY integrations_delete
  ON public.integrations
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = integrations.project_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  );

-- test_templates (via project org)
CREATE POLICY test_templates_select
  ON public.test_templates
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = test_templates.project_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  );

CREATE POLICY test_templates_insert
  ON public.test_templates
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  );

CREATE POLICY test_templates_update
  ON public.test_templates
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = test_templates.project_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  );

CREATE POLICY test_templates_delete
  ON public.test_templates
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = test_templates.project_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  );

-- test_runs (via project org)
CREATE POLICY test_runs_select
  ON public.test_runs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = test_runs.project_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  );

CREATE POLICY test_runs_insert
  ON public.test_runs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  );

CREATE POLICY test_runs_update
  ON public.test_runs
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = test_runs.project_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  );

CREATE POLICY test_runs_delete
  ON public.test_runs
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = test_runs.project_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  );

-- test_results (via test_run -> project org)
CREATE POLICY test_results_select
  ON public.test_results
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.test_runs tr
      INNER JOIN public.projects p ON p.id = tr.project_id
      WHERE tr.id = test_results.test_run_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  );

CREATE POLICY test_results_insert
  ON public.test_results
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.test_runs tr
      INNER JOIN public.projects p ON p.id = tr.project_id
      WHERE tr.id = test_run_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  );

CREATE POLICY test_results_update
  ON public.test_results
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.test_runs tr
      INNER JOIN public.projects p ON p.id = tr.project_id
      WHERE tr.id = test_results.test_run_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.test_runs tr
      INNER JOIN public.projects p ON p.id = tr.project_id
      WHERE tr.id = test_run_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  );

CREATE POLICY test_results_delete
  ON public.test_results
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.test_runs tr
      INNER JOIN public.projects p ON p.id = tr.project_id
      WHERE tr.id = test_results.test_run_id
        AND p.org_id IN (SELECT public.get_user_org_ids())
    )
  );
