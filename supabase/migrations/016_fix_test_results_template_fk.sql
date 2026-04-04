-- Fix: project deletion fails because test_results.test_template_id
-- references test_templates(id) without ON DELETE handling.
-- When a project is deleted, the cascade to test_templates can be processed
-- before test_results are removed (via test_runs cascade), causing:
--   "update or delete on table "test_templates" violates foreign key constraint
--    "test_results_test_template_id_fkey" on table "test_results""
--
-- SET NULL is appropriate here: the column is already nullable, and historical
-- test results should be preserved even when their template is removed.

ALTER TABLE public.test_results
  DROP CONSTRAINT test_results_test_template_id_fkey,
  ADD CONSTRAINT test_results_test_template_id_fkey
    FOREIGN KEY (test_template_id) REFERENCES public.test_templates (id)
    ON DELETE SET NULL;
