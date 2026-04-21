-- Allow deleting auth users who created organizations: remove those orgs (and
-- dependent public data cascades from organizations.id, e.g. projects).
ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_created_by_fkey;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_created_by_fkey
  FOREIGN KEY (created_by)
  REFERENCES auth.users (id)
  ON DELETE CASCADE;
