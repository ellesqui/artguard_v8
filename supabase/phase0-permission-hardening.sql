-- Forward-only Phase 0 permission and SECURITY DEFINER hardening.
-- Apply only after confirming every referenced function exists with the
-- signature below in a non-production project.

begin;

-- Remove public/anonymous access while preserving the frontend and trusted
-- backend execution paths. PostgreSQL owners retain their inherent privileges.
revoke execute on function public.accept_commission_request(uuid) from PUBLIC, anon;
grant execute on function public.accept_commission_request(uuid) to authenticated, service_role;

revoke execute on function public.approve_artist_verification(uuid) from PUBLIC, anon;
grant execute on function public.approve_artist_verification(uuid) to authenticated, service_role;

revoke execute on function public.approve_commission_deliverable(uuid) from PUBLIC, anon;
grant execute on function public.approve_commission_deliverable(uuid) to authenticated, service_role;

revoke execute on function public.approve_commission_milestone(uuid) from PUBLIC, anon;
grant execute on function public.approve_commission_milestone(uuid) to authenticated, service_role;

revoke execute on function public.cancel_commission(uuid, text) from PUBLIC, anon;
grant execute on function public.cancel_commission(uuid, text) to authenticated, service_role;

revoke execute on function public.complete_commission(uuid) from PUBLIC, anon;
grant execute on function public.complete_commission(uuid) to authenticated, service_role;

revoke execute on function public.list_pending_artist_verifications() from PUBLIC, anon;
grant execute on function public.list_pending_artist_verifications() to authenticated, service_role;

revoke execute on function public.reject_artist_verification(uuid, text) from PUBLIC, anon;
grant execute on function public.reject_artist_verification(uuid, text) to authenticated, service_role;

-- start_commission(uuid) already has the intended authenticated-only grant.
-- Do not change its execution privileges here.

-- Submitted commission derivatives are used by an authenticated Storage
-- policy. Keep authenticated and trusted backend execution after removing
-- inherited PUBLIC access.
revoke execute on function public.is_submitted_commission_derivative(text) from PUBLIC, anon;
grant execute on function public.is_submitted_commission_derivative(text) to authenticated, service_role;

-- Standardize the lookup path without replacing established function bodies.
alter function public.accept_commission_request(uuid)
  set search_path = pg_catalog, public, pg_temp;
alter function public.approve_artist_verification(uuid)
  set search_path = pg_catalog, public, pg_temp;
alter function public.approve_commission_deliverable(uuid)
  set search_path = pg_catalog, public, pg_temp;
alter function public.approve_commission_milestone(uuid)
  set search_path = pg_catalog, public, pg_temp;
alter function public.cancel_commission(uuid, text)
  set search_path = pg_catalog, public, pg_temp;
alter function public.complete_commission(uuid)
  set search_path = pg_catalog, public, pg_temp;
alter function public.list_pending_artist_verifications()
  set search_path = pg_catalog, public, pg_temp;
alter function public.reject_artist_verification(uuid, text)
  set search_path = pg_catalog, public, pg_temp;
alter function public.start_commission(uuid)
  set search_path = pg_catalog, public, pg_temp;

alter function public.is_submitted_commission_derivative(text)
  set search_path = pg_catalog, public, pg_temp;
alter function public.is_public_artwork_derivative(text)
  set search_path = pg_catalog, public, pg_temp;
alter function public.can_upload_chat_attachment(text)
  set search_path = pg_catalog, public, pg_temp;

-- Helpers added by profile-access-hardening.sql.
alter function public.get_my_profile()
  set search_path = pg_catalog, public, pg_temp;
alter function public.is_current_user_admin()
  set search_path = pg_catalog, public, pg_temp;

commit;
