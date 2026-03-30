-- Atlas QA Platform - Test results
CREATE TABLE public.test_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_run_id UUID NOT NULL REFERENCES public.test_runs (id) ON DELETE CASCADE,
  test_template_id UUID REFERENCES public.test_templates (id),
  status result_status NOT NULL,
  duration_ms INTEGER,
  error_message TEXT,
  screenshots TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  console_logs JSONB,
  network_errors JSONB,
  ai_analysis TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX test_results_test_run_id_idx ON public.test_results (test_run_id);
