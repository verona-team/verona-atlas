-- Atlas QA Platform - Test templates
CREATE TABLE public.test_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  steps JSONB NOT NULL DEFAULT '[]',
  source template_source NOT NULL DEFAULT 'manual',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX test_templates_project_id_idx ON public.test_templates (project_id);

CREATE TRIGGER test_templates_set_updated_at
  BEFORE UPDATE ON public.test_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();
