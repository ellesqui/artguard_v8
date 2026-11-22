-- Forward-only profile access EXPAND stage.
-- Apply before deploying the frontend that uses get_my_profile().
-- This stage deliberately retains authenticated SELECT * compatibility.

-- Keep the existing public-profile row access available to authenticated
-- clients while old and new frontend bundles overlap. The existing row policy
-- is intentionally left untouched.
grant select on table public.profiles to authenticated;

-- Return only the current authenticated user's complete profile. The caller
-- cannot supply another user's ID; auth.uid() is the sole lookup key.
create or replace function public.get_my_profile()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select to_jsonb(p)
  from public.profiles as p
  where p.id = auth.uid()
$$;

revoke all on function public.get_my_profile() from public, anon, authenticated;
grant execute on function public.get_my_profile() to authenticated;

-- Used by the later CONTRACT-stage verification preview policy so admin
-- status can remain private without changing the existing verification RPCs.
create or replace function public.is_current_user_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles as p
    where p.id = auth.uid()
      and p.is_admin is true
  )
$$;

revoke all on function public.is_current_user_admin() from public, anon, authenticated;
grant execute on function public.is_current_user_admin() to authenticated;

-- This stage intentionally does not revoke profile column SELECT privileges,
-- change profile INSERT policies/grants, or alter auth signup triggers.
