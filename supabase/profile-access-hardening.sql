-- Forward-only profile access CONTRACT stage.
-- Apply only after profile-access-expand.sql, compatible frontend deployment,
-- and the documented legacy-client deprecation gate have completed.

begin;

-- Remove table-wide and column-level profile reads, then expose only the
-- fields required by public artist/client profiles and authenticated workflows.
revoke select on table public.profiles from public, anon, authenticated;
revoke select (
  id,
  name,
  username,
  role,
  bio,
  interests,
  avatar_data_url,
  onboarded,
  is_pro,
  last_seen_at,
  created_at,
  updated_at,
  accepting_commissions,
  artist_verification_status,
  artist_verification_submitted_at,
  artist_verification_reviewed_at,
  artist_verification_reviewed_by,
  artist_verification_rejection_reason,
  artist_verification_artwork_id,
  is_admin
) on table public.profiles from public, anon, authenticated;

grant select (
  id,
  name,
  username,
  role,
  bio,
  interests,
  avatar_data_url,
  onboarded,
  is_pro,
  last_seen_at,
  accepting_commissions,
  artist_verification_status
) on table public.profiles to authenticated;
grant select on table public.profiles to service_role;

drop policy if exists "authenticated users can read profiles" on public.profiles;
create policy "authenticated users can read profiles"
on public.profiles for select
to authenticated
using (true);

drop policy if exists "admins can read protected verification previews" on storage.objects;
create policy "admins can read protected verification previews"
on storage.objects for select
to authenticated
using (
  bucket_id = 'artworks'
  and (storage.foldername(name))[2] = 'protected'
  and public.is_current_user_admin()
);

-- Keep admin-only verification flows callable by authenticated clients without
-- leaving their privileged RPCs executable by anon or PUBLIC.
revoke execute on function public.approve_artist_verification(uuid) from public, anon;
revoke execute on function public.reject_artist_verification(uuid, text) from public, anon;
revoke execute on function public.list_pending_artist_verifications() from public, anon;
grant execute on function public.approve_artist_verification(uuid) to authenticated;
grant execute on function public.reject_artist_verification(uuid, text) to authenticated;
grant execute on function public.list_pending_artist_verifications() to authenticated;

revoke execute on function public.accept_commission_request(uuid) from public, anon;
revoke execute on function public.approve_commission_deliverable(uuid) from public, anon;
revoke execute on function public.approve_commission_milestone(uuid) from public, anon;
revoke execute on function public.cancel_commission(uuid, text) from public, anon;
revoke execute on function public.complete_commission(uuid) from public, anon;
grant execute on function public.accept_commission_request(uuid) to authenticated;
grant execute on function public.approve_commission_deliverable(uuid) to authenticated;
grant execute on function public.approve_commission_milestone(uuid) to authenticated;
grant execute on function public.cancel_commission(uuid, text) to authenticated;
grant execute on function public.complete_commission(uuid) to authenticated;

revoke execute on function public.is_submitted_commission_derivative(text) from public, anon;

-- Harden the SECURITY DEFINER functions in these profile, verification, and
-- Storage flows without replacing their established bodies.
alter function public.handle_new_user()
  set search_path = pg_catalog, public, pg_temp;
alter function public.submit_artist_verification(text, text, text[], uuid)
  set search_path = pg_catalog, public, pg_temp;
alter function public.approve_artist_verification(uuid)
  set search_path = pg_catalog, public, pg_temp;
alter function public.reject_artist_verification(uuid, text)
  set search_path = pg_catalog, public, pg_temp;
alter function public.list_pending_artist_verifications()
  set search_path = pg_catalog, public, pg_temp;
alter function public.can_upload_chat_attachment(text)
  set search_path = pg_catalog, public, pg_temp;
alter function public.is_public_artwork_derivative(text)
  set search_path = pg_catalog, public, pg_temp;
alter function public.is_submitted_commission_derivative(text)
  set search_path = pg_catalog, public, pg_temp;

commit;
