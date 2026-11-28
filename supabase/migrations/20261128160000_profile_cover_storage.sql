-- Artist and Client profile covers use private Storage objects; profile rows
-- keep only the object path. Apply locally for review before any deployment.

begin;

alter table public.profiles
  add column if not exists cover_image_path text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_cover_image_path_owner_check'
  ) then
    alter table public.profiles
      add constraint profiles_cover_image_path_owner_check
      check (
        cover_image_path is null
        or cover_image_path ~* (
          '^' || id::text || '/cover/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$'
        )
      );
  end if;
end;
$$;

grant select (cover_image_path) on table public.profiles to authenticated;
grant update (cover_image_path) on table public.profiles to authenticated;
grant select on table public.profiles to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-covers', 'profile-covers', false, 2097152, array['image/jpeg', 'image/png'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "profile owners can upload artist covers" on storage.objects;
drop policy if exists "profile owners can upload covers" on storage.objects;
create policy "profile owners can upload covers"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'profile-covers'
  and array_length(storage.foldername(name), 1) = 2
  and (storage.foldername(name))[1] = auth.uid()::text
  and (storage.foldername(name))[2] = 'cover'
  and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/cover/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$'
  and exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('artist', 'client')
  )
);

drop policy if exists "authenticated users can read referenced artist covers" on storage.objects;
drop policy if exists "authenticated users can read referenced profile covers" on storage.objects;
create policy "authenticated users can read referenced profile covers"
on storage.objects for select
to authenticated
using (
  bucket_id = 'profile-covers'
  and exists (
    select 1
    from public.profiles p
    where p.cover_image_path = storage.objects.name
      and p.role in ('artist', 'client')
  )
);

drop policy if exists "profile owners can delete their covers" on storage.objects;
create policy "profile owners can delete their covers"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'profile-covers'
  and array_length(storage.foldername(name), 1) = 2
  and (storage.foldername(name))[1] = auth.uid()::text
  and (storage.foldername(name))[2] = 'cover'
  and exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('artist', 'client')
  )
);

drop policy if exists artguard_active_account_storage_access on storage.objects;
create policy artguard_active_account_storage_access
on storage.objects as restrictive
for all
to authenticated
using (
  bucket_id not in ('artworks', 'chat-attachments', 'profile-covers')
  or public.is_my_account_writable()
)
with check (
  bucket_id not in ('artworks', 'chat-attachments', 'profile-covers')
  or public.is_my_account_writable()
);

commit;
