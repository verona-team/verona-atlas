-- Remove public app rows tied to an auth user so auth deletion (dashboard, SQL,
-- or Admin API) succeeds even if `organizations.created_by` still uses the
-- default NO ACTION on older databases, or you prefer explicit cleanup first.
--
-- Usage (service role / SQL editor as postgres):
--   SELECT public.delete_auth_user_app_data('USER_UUID'::uuid);
--   DELETE FROM auth.users WHERE id = 'USER_UUID'::uuid;

CREATE OR REPLACE FUNCTION public.delete_auth_user_app_data(target_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'target_user_id is required';
  END IF;

  DELETE FROM public.org_members
  WHERE user_id = target_user_id;

  DELETE FROM public.organizations
  WHERE created_by = target_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_auth_user_app_data(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_auth_user_app_data(UUID) TO service_role;

COMMENT ON FUNCTION public.delete_auth_user_app_data(UUID) IS
  'Deletes org_memberships and organizations created_by this user (cascades to projects, runs, etc.). Call before removing auth.users when FKs block deletion.';
