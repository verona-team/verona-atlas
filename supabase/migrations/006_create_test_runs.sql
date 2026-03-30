-- Atlas QA Platform - Test runs
CREATE TABLE public.test_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  trigger run_trigger NOT NULL,
  trigger_ref TEXT,
  status run_status NOT NULL DEFAULT 'pending',
  modal_call_id TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  summary JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX test_runs_project_id_idx ON public.test_runs (project_id);
CREATE INDEX test_runs_status_idx ON public.test_runs (status);
