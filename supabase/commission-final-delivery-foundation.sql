-- Final Delivery is separate from milestone deliverables and revisions.
-- Apply only after reviewing against the target database. This file is local
-- source and is not applied automatically.

begin;

alter table public.commissions
  add column if not exists final_delivery_required boolean not null default false;

comment on column public.commissions.final_delivery_required is
  'Requires an accepted current Final Delivery batch before commission completion.';

create table if not exists public.commission_final_deliveries (
  id uuid primary key default gen_random_uuid(),
  commission_id uuid not null references public.commissions(id) on delete restrict,
  artist_id uuid not null references auth.users(id) on delete restrict,
  client_id uuid not null references auth.users(id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0),
  status text not null default 'UPLOADING'
    check (status in (
      'UPLOADING',
      'AWAITING_CLIENT_REVIEW',
      'REVISION_REQUESTED',
      'ACCEPTED',
      'ABANDONED'
    )),
  is_current boolean not null default false,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete restrict,
  revision_reason text,
  cleanup_completed_at timestamptz,
  constraint commission_final_deliveries_attempt_unique
    unique (commission_id, attempt_number),
  constraint commission_final_deliveries_state_fields check (
    (
      status = 'UPLOADING'
      and expires_at is not null
      and submitted_at is null
      and decided_at is null
      and decided_by is null
      and revision_reason is null
      and is_current = false
    )
    or (
      status = 'AWAITING_CLIENT_REVIEW'
      and expires_at is null
      and submitted_at is not null
      and decided_at is null
      and decided_by is null
      and revision_reason is null
    )
    or (
      status = 'REVISION_REQUESTED'
      and expires_at is null
      and submitted_at is not null
      and decided_at is not null
      and decided_by is not null
      and revision_reason is not null
      and length(btrim(revision_reason)) > 0
    )
    or (
      status = 'ACCEPTED'
      and expires_at is null
      and submitted_at is not null
      and decided_at is not null
      and decided_by is not null
      and revision_reason is null
    )
    or (
      status = 'ABANDONED'
      and is_current = false
      and decided_at is null
      and decided_by is null
      and revision_reason is null
    )
  ),
  constraint commission_final_deliveries_current_state check (
    not is_current
    or status in ('AWAITING_CLIENT_REVIEW', 'REVISION_REQUESTED', 'ACCEPTED')
  )
);

create unique index if not exists commission_final_deliveries_one_current_idx
  on public.commission_final_deliveries(commission_id)
  where is_current;
create index if not exists commission_final_deliveries_commission_history_idx
  on public.commission_final_deliveries(commission_id, attempt_number desc);
create index if not exists commission_final_deliveries_expiry_idx
  on public.commission_final_deliveries(expires_at)
  where status = 'UPLOADING';

create table if not exists public.commission_final_delivery_files (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null
    references public.commission_final_deliveries(id) on delete restrict,
  storage_path text not null unique,
  display_filename text not null,
  declared_mime_type text not null
    check (declared_mime_type in ('image/jpeg', 'image/png', 'application/pdf')),
  client_reported_size_bytes bigint
    check (client_reported_size_bytes is null or client_reported_size_bytes > 0),
  verification_status text not null default 'RESERVED'
    check (verification_status in ('RESERVED', 'VERIFIED')),
  verified_mime_type text
    check (verified_mime_type is null or verified_mime_type in ('image/jpeg', 'image/png', 'application/pdf')),
  file_size_bytes bigint
    check (file_size_bytes is null or file_size_bytes between 1 and 41943040),
  sha256 text
    check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  constraint commission_final_delivery_files_verification_fields check (
    (
      verification_status = 'RESERVED'
      and verified_mime_type is null
      and file_size_bytes is null
      and sha256 is null
      and verified_at is null
    )
    or (
      verification_status = 'VERIFIED'
      and verified_mime_type is not null
      and file_size_bytes is not null
      and sha256 is not null
      and verified_at is not null
    )
  )
);

create index if not exists commission_final_delivery_files_delivery_idx
  on public.commission_final_delivery_files(delivery_id, created_at, id);
create index if not exists commission_final_delivery_files_reserved_idx
  on public.commission_final_delivery_files(delivery_id)
  where verification_status = 'RESERVED';

alter table public.commission_final_deliveries enable row level security;
alter table public.commission_final_delivery_files enable row level security;
revoke all on public.commission_final_deliveries from public, anon, authenticated;
revoke all on public.commission_final_delivery_files from public, anon, authenticated;

create policy "commission participants can read final delivery history"
on public.commission_final_deliveries for select
to authenticated
using (
  exists (
    select 1
    from public.commissions as commission
    where commission.id = commission_final_deliveries.commission_id
      and (
        commission.artist_id = auth.uid()
        or (
          commission.client_id = auth.uid()
          and commission_final_deliveries.status not in ('UPLOADING', 'ABANDONED')
        )
      )
  )
);

create policy "commission participants can read committed final delivery metadata"
on public.commission_final_delivery_files for select
to authenticated
using (
  exists (
    select 1
    from public.commission_final_deliveries as delivery
    join public.commissions as commission
      on commission.id = delivery.commission_id
    where delivery.id = commission_final_delivery_files.delivery_id
      and (
        commission.artist_id = auth.uid()
        or (
          commission.client_id = auth.uid()
          and delivery.status not in ('UPLOADING', 'ABANDONED')
        )
      )
  )
);

grant select on public.commission_final_deliveries to authenticated;
grant select (
  id,
  delivery_id,
  display_filename,
  declared_mime_type,
  client_reported_size_bytes,
  verification_status,
  verified_mime_type,
  file_size_bytes,
  sha256,
  created_at,
  verified_at
) on public.commission_final_delivery_files to authenticated;

create or replace function public.is_final_render_approved(p_commission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(
    count(*) = 1 and bool_and(milestone.status = 'APPROVED'),
    false
  )
  from public.commission_milestones as milestone
  where milestone.commission_id = p_commission_id
    and milestone.name = 'Final Render'
$$;

revoke all on function public.is_final_render_approved(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.can_upload_final_delivery_object(p_object_path text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.commission_final_delivery_files as file
    join public.commission_final_deliveries as delivery
      on delivery.id = file.delivery_id
    join public.commissions as commission
      on commission.id = delivery.commission_id
    join public.profiles as profile
      on profile.id = auth.uid()
    where file.storage_path = p_object_path
      and file.verification_status = 'RESERVED'
      and delivery.status = 'UPLOADING'
      and delivery.expires_at > now() + interval '3 hours'
      and delivery.artist_id = auth.uid()
      and delivery.created_by = auth.uid()
      and commission.artist_id = auth.uid()
      and commission.final_delivery_required
      and commission.status in ('IN_PROGRESS', 'REVISION_REQUESTED')
      and profile.role = 'artist'
      and public.is_final_render_approved(commission.id)
  )
$$;

create or replace function public.can_read_final_delivery_object(p_object_path text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.commission_final_delivery_files as file
    join public.commission_final_deliveries as delivery
      on delivery.id = file.delivery_id
    join public.commissions as commission
      on commission.id = delivery.commission_id
    where file.storage_path = p_object_path
      and file.verification_status = 'VERIFIED'
      and delivery.status in ('AWAITING_CLIENT_REVIEW', 'REVISION_REQUESTED', 'ACCEPTED')
      and (
        commission.artist_id = auth.uid()
        or commission.client_id = auth.uid()
      )
  )
$$;

revoke all on function public.can_upload_final_delivery_object(text) from public, anon;
revoke all on function public.can_read_final_delivery_object(text) from public, anon;
grant execute on function public.can_upload_final_delivery_object(text) to authenticated;
grant execute on function public.can_read_final_delivery_object(text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'commission-final-deliveries',
  'commission-final-deliveries',
  false,
  41943040,
  array['image/jpeg', 'image/png', 'application/pdf']
)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1
    from storage.buckets as bucket
    where bucket.id = 'commission-final-deliveries'
      and bucket.public is false
      and bucket.file_size_limit = 41943040
      and cardinality(bucket.allowed_mime_types) = 3
      and bucket.allowed_mime_types @> array['image/jpeg', 'image/png', 'application/pdf']
  ) then
    raise exception 'commission-final-deliveries bucket must be private, allow exactly JPEG/PNG/PDF, and have an exact per-file limit of 41943040 bytes';
  end if;
end;
$$;

drop policy if exists "Artists can upload reserved Final Delivery files" on storage.objects;
create policy "Artists can upload reserved Final Delivery files"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'commission-final-deliveries'
  and public.can_upload_final_delivery_object(name)
);

drop policy if exists "Participants can read committed Final Delivery files" on storage.objects;
create policy "Participants can read committed Final Delivery files"
on storage.objects for select
to authenticated
using (
  bucket_id = 'commission-final-deliveries'
  and public.can_read_final_delivery_object(name)
);

-- Deliberately no authenticated UPDATE or DELETE policy for this bucket.
-- Uploads use unique reserved paths and upsert=false; cleanup runs server-side.

create or replace function public.guard_commission_final_delivery_transition()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'UPLOADING' or new.is_current then
      raise exception 'Final Delivery batches must begin as non-current uploads';
    end if;
    if not exists (
      select 1
      from public.commissions as commission
      where commission.id = new.commission_id
        and commission.artist_id = new.artist_id
        and commission.client_id = new.client_id
    ) then
      raise exception 'Final Delivery participants do not match the commission';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status
    and not (
      (old.status = 'UPLOADING' and new.status in ('AWAITING_CLIENT_REVIEW', 'ABANDONED'))
      or (
        old.status = 'AWAITING_CLIENT_REVIEW'
        and new.status in ('REVISION_REQUESTED', 'ACCEPTED')
      )
    ) then
    raise exception 'Invalid Final Delivery batch status transition';
  end if;

  if row(
    new.commission_id, new.artist_id, new.client_id, new.attempt_number,
    new.created_by, new.created_at
  ) is distinct from row(
    old.commission_id, old.artist_id, old.client_id, old.attempt_number,
    old.created_by, old.created_at
  ) then
    raise exception 'Final Delivery batch identity is immutable';
  end if;

  if old.status <> 'UPLOADING'
    and row(new.submitted_at, new.decided_at, new.decided_by, new.revision_reason)
      is distinct from
      row(old.submitted_at, old.decided_at, old.decided_by, old.revision_reason)
    and not (
      old.status = 'AWAITING_CLIENT_REVIEW'
      and new.status in ('REVISION_REQUESTED', 'ACCEPTED')
    ) then
    raise exception 'Final Delivery review history is immutable';
  end if;

  if old.status in ('REVISION_REQUESTED', 'ACCEPTED', 'ABANDONED')
    and new.status is distinct from old.status then
    raise exception 'Final Delivery history is immutable';
  end if;

  return new;
end;
$$;

drop trigger if exists commission_final_deliveries_guard_transition
  on public.commission_final_deliveries;
create trigger commission_final_deliveries_guard_transition
before insert or update on public.commission_final_deliveries
for each row execute function public.guard_commission_final_delivery_transition();

create or replace function public.guard_commission_final_delivery_file_update()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Final Delivery file history cannot be deleted';
  end if;

  if old.verification_status <> 'RESERVED' then
    raise exception 'Verified Final Delivery file metadata is immutable';
  end if;

  if row(new.id, new.delivery_id, new.storage_path, new.display_filename,
         new.declared_mime_type, new.client_reported_size_bytes, new.created_at)
    is distinct from
    row(old.id, old.delivery_id, old.storage_path, old.display_filename,
        old.declared_mime_type, old.client_reported_size_bytes, old.created_at) then
    raise exception 'Final Delivery file reservation is immutable';
  end if;

  if new.verification_status not in ('RESERVED', 'VERIFIED') then
    raise exception 'Invalid Final Delivery file verification state';
  end if;

  return new;
end;
$$;

drop trigger if exists commission_final_delivery_files_guard_update
  on public.commission_final_delivery_files;
create trigger commission_final_delivery_files_guard_update
before update or delete on public.commission_final_delivery_files
for each row execute function public.guard_commission_final_delivery_file_update();

create or replace function public.begin_commission_final_delivery(
  p_commission_id uuid,
  p_files jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_commission public.commissions;
  v_delivery_id uuid := gen_random_uuid();
  v_attempt_number integer;
  v_file jsonb;
  v_file_id uuid;
  v_filename text;
  v_mime text;
  v_reported_size bigint;
  v_files jsonb := '[]'::jsonb;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  select profile.role into v_role
  from public.profiles as profile
  where profile.id = v_user;
  if v_role is distinct from 'artist' then
    raise exception 'Only Artists can submit Final Delivery';
  end if;

  select commission.* into v_commission
  from public.commissions as commission
  where commission.id = p_commission_id
  for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_commission.artist_id is distinct from v_user then
    raise exception 'Not authorized for this commission';
  end if;
  if v_commission.final_delivery_required is distinct from true then
    raise exception 'Final Delivery is not enabled for this commission';
  end if;
  if v_commission.status not in ('IN_PROGRESS', 'REVISION_REQUESTED') then
    raise exception 'Commission is not accepting Final Delivery';
  end if;
  if not public.is_final_render_approved(v_commission.id) then
    raise exception 'Final Render must be approved before Final Delivery';
  end if;
  if jsonb_typeof(p_files) is distinct from 'array' then
    raise exception 'Final Delivery files must be provided as an array';
  end if;
  if jsonb_array_length(p_files) = 0 then
    raise exception 'At least one Final Delivery file is required';
  end if;
  if exists (
    select 1
    from public.commission_final_deliveries as current_delivery
    where current_delivery.commission_id = v_commission.id
      and current_delivery.is_current
      and current_delivery.status <> 'REVISION_REQUESTED'
  ) then
    raise exception 'A current Final Delivery is already awaiting review or accepted';
  end if;

  select coalesce(max(delivery.attempt_number), 0) + 1
  into v_attempt_number
  from public.commission_final_deliveries as delivery
  where delivery.commission_id = v_commission.id;

  insert into public.commission_final_deliveries (
    id, commission_id, artist_id, client_id, attempt_number, status,
    is_current, created_by, expires_at
  )
  values (
    v_delivery_id, v_commission.id, v_commission.artist_id, v_commission.client_id,
    v_attempt_number, 'UPLOADING', false, v_user, now() + interval '24 hours'
  );

  for v_file in select value from jsonb_array_elements(p_files)
  loop
    v_filename := left(
      btrim(regexp_replace(coalesce(v_file ->> 'filename', ''), '[^A-Za-z0-9._ -]', '_', 'g')),
      255
    );
    v_mime := lower(btrim(coalesce(v_file ->> 'mime_type', '')));
    if v_filename = '' then raise exception 'Final Delivery filename is required'; end if;
    if v_mime not in ('image/jpeg', 'image/png', 'application/pdf') then
      raise exception 'Unsupported Final Delivery file type';
    end if;
    if nullif(v_file ->> 'size_bytes', '') is not null then
      begin
        v_reported_size := (v_file ->> 'size_bytes')::bigint;
      exception when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'Invalid client-reported file size';
      end;
      if v_reported_size <= 0 then raise exception 'Invalid client-reported file size'; end if;
    else
      v_reported_size := null;
    end if;

    v_file_id := gen_random_uuid();
    insert into public.commission_final_delivery_files (
      id, delivery_id, storage_path, display_filename, declared_mime_type,
      client_reported_size_bytes
    )
    values (
      v_file_id,
      v_delivery_id,
      v_commission.id::text || '/' || v_delivery_id::text || '/' || v_file_id::text,
      v_filename,
      v_mime,
      v_reported_size
    );
    v_files := v_files || jsonb_build_array(jsonb_build_object(
      'file_id', v_file_id,
      'filename', v_filename
    ));
  end loop;

  return jsonb_build_object(
    'delivery_id', v_delivery_id,
    'attempt_number', v_attempt_number,
    'files', v_files,
    'expires_at', now() + interval '24 hours'
  );
end;
$$;

revoke all on function public.begin_commission_final_delivery(uuid, jsonb)
  from public, anon;
grant execute on function public.begin_commission_final_delivery(uuid, jsonb)
  to authenticated;

create or replace function public.get_final_delivery_upload_targets(
  p_delivery_id uuid,
  p_actor_id uuid
)
returns table (
  file_id uuid,
  storage_path text,
  display_filename text,
  declared_mime_type text,
  client_reported_size_bytes bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_actor_id is null or not exists (
    select 1
    from public.commission_final_deliveries as delivery
    join public.commissions as commission on commission.id = delivery.commission_id
    where delivery.id = p_delivery_id
      and delivery.status = 'UPLOADING'
      and delivery.artist_id = p_actor_id
      and delivery.created_by = p_actor_id
      and commission.artist_id = p_actor_id
      and commission.final_delivery_required
      and commission.status in ('IN_PROGRESS', 'REVISION_REQUESTED')
      and public.is_final_render_approved(commission.id)
  ) then
    raise exception 'Not authorized to upload these Final Delivery files';
  end if;

  if exists (
    select 1
    from public.commission_final_deliveries as delivery
    where delivery.id = p_delivery_id
      and delivery.status = 'UPLOADING'
      and delivery.expires_at <= now()
  ) then
    raise exception 'Final Delivery upload reservation has expired';
  end if;

  if exists (
    select 1
    from public.commission_final_deliveries as delivery
    where delivery.id = p_delivery_id
      and delivery.status = 'UPLOADING'
      and delivery.expires_at <= now() + interval '3 hours'
  ) then
    raise exception 'FINAL_DELIVERY_UPLOAD_CUTOFF: Signed upload URLs require more than three hours before reservation expiry';
  end if;

  return query
  select file.id, file.storage_path, file.display_filename,
         file.declared_mime_type, file.client_reported_size_bytes
  from public.commission_final_delivery_files as file
  where file.delivery_id = p_delivery_id
    and file.verification_status = 'RESERVED'
  order by file.created_at, file.id;
end;
$$;

revoke all on function public.get_final_delivery_upload_targets(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_final_delivery_upload_targets(uuid, uuid)
  to service_role;

create or replace function public.get_final_delivery_verification_targets(
  p_delivery_id uuid,
  p_actor_id uuid
)
returns table (
  file_id uuid,
  storage_path text,
  display_filename text,
  declared_mime_type text,
  client_reported_size_bytes bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_actor_id is null or not exists (
    select 1
    from public.commission_final_deliveries as delivery
    join public.commissions as commission on commission.id = delivery.commission_id
    where delivery.id = p_delivery_id
      and delivery.status = 'UPLOADING'
      and delivery.artist_id = p_actor_id
      and delivery.created_by = p_actor_id
      and commission.artist_id = p_actor_id
      and commission.final_delivery_required
      and commission.status in ('IN_PROGRESS', 'REVISION_REQUESTED')
      and public.is_final_render_approved(commission.id)
  ) then
    raise exception 'Not authorized to verify these Final Delivery files';
  end if;

  if exists (
    select 1
    from public.commission_final_deliveries as delivery
    where delivery.id = p_delivery_id
      and delivery.status = 'UPLOADING'
      and delivery.expires_at <= now()
  ) then
    raise exception 'Final Delivery upload reservation has expired';
  end if;

  return query
  select file.id, file.storage_path, file.display_filename,
         file.declared_mime_type, file.client_reported_size_bytes
  from public.commission_final_delivery_files as file
  where file.delivery_id = p_delivery_id
    and file.verification_status = 'RESERVED'
  order by file.created_at, file.id;
end;
$$;

revoke all on function public.get_final_delivery_verification_targets(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_final_delivery_verification_targets(uuid, uuid)
  to service_role;

create or replace function public.finalize_commission_final_delivery(
  p_delivery_id uuid,
  p_actor_id uuid,
  p_verified_files jsonb
)
returns public.commission_final_deliveries
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_delivery public.commission_final_deliveries;
  v_commission public.commissions;
  v_expected_count integer;
  v_verified_count integer;
  v_entry jsonb;
  v_file public.commission_final_delivery_files;
  v_file_id uuid;
  v_mime text;
  v_size bigint;
  v_hash text;
  v_client_name text;
begin
  if p_actor_id is null then raise exception 'Final Delivery actor is required'; end if;
  if jsonb_typeof(p_verified_files) is distinct from 'array' then
    raise exception 'Verified file manifest must be an array';
  end if;

  select commission.* into v_commission
  from public.commissions as commission
  join public.commission_final_deliveries as delivery
    on delivery.commission_id = commission.id
  where delivery.id = p_delivery_id
  for update of commission;
  if not found then raise exception 'Commission not found'; end if;

  select delivery.* into v_delivery
  from public.commission_final_deliveries as delivery
  where delivery.id = p_delivery_id
  for update;
  if not found then raise exception 'Final Delivery batch not found'; end if;
  if v_delivery.status is distinct from 'UPLOADING'
    or v_delivery.artist_id is distinct from p_actor_id
    or v_delivery.created_by is distinct from p_actor_id
    or v_commission.artist_id is distinct from p_actor_id
    or v_commission.final_delivery_required is distinct from true then
    raise exception 'Final Delivery batch is not eligible for submission';
  end if;
  if v_delivery.expires_at <= now() then
    raise exception 'Final Delivery upload session has expired';
  end if;
  if v_commission.status not in ('IN_PROGRESS', 'REVISION_REQUESTED')
    or not public.is_final_render_approved(v_commission.id) then
    raise exception 'Final Render must be approved before Final Delivery';
  end if;

  select count(*) into v_expected_count
  from public.commission_final_delivery_files as file
  where file.delivery_id = v_delivery.id
    and file.verification_status = 'RESERVED';
  select count(distinct value ->> 'file_id') into v_verified_count
  from jsonb_array_elements(p_verified_files);
  if v_expected_count = 0 or v_verified_count <> v_expected_count
    or jsonb_array_length(p_verified_files) <> v_expected_count then
    raise exception 'Every reserved Final Delivery file must be verified';
  end if;

  for v_entry in select value from jsonb_array_elements(p_verified_files)
  loop
    begin
      v_file_id := (v_entry ->> 'file_id')::uuid;
      v_size := (v_entry ->> 'size_bytes')::bigint;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Invalid verified file manifest';
    end;
    v_mime := v_entry ->> 'mime_type';
    v_hash := lower(v_entry ->> 'sha256');

    select file.* into v_file
    from public.commission_final_delivery_files as file
    where file.id = v_file_id
      and file.delivery_id = v_delivery.id
      and file.verification_status = 'RESERVED'
    for update;
    if not found then raise exception 'Verified file is not reserved for this batch'; end if;
    if v_mime is distinct from v_file.declared_mime_type
      or v_mime not in ('image/jpeg', 'image/png', 'application/pdf')
      or v_size is null or v_size < 1 or v_size > 41943040
      or (
        v_file.client_reported_size_bytes is not null
        and v_file.client_reported_size_bytes <> v_size
      )
      or v_hash is null
      or v_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'Verified Final Delivery file metadata is invalid';
    end if;

    update public.commission_final_delivery_files
    set verification_status = 'VERIFIED',
        verified_mime_type = v_mime,
        file_size_bytes = v_size,
        sha256 = v_hash,
        verified_at = now()
    where id = v_file.id
      and verification_status = 'RESERVED';
  end loop;

  if exists (
    select 1 from public.commission_final_delivery_files as file
    where file.delivery_id = v_delivery.id
      and file.verification_status <> 'VERIFIED'
  ) then
    raise exception 'Every reserved Final Delivery file must be verified';
  end if;

  if exists (
    select 1
    from public.commission_final_deliveries as current_delivery
    where current_delivery.commission_id = v_commission.id
      and current_delivery.is_current
      and current_delivery.status <> 'REVISION_REQUESTED'
  ) then
    raise exception 'Another Final Delivery is already awaiting review or accepted';
  end if;

  update public.commission_final_deliveries
  set is_current = false
  where commission_id = v_commission.id
    and is_current
    and status = 'REVISION_REQUESTED';

  update public.commission_final_deliveries
  set status = 'AWAITING_CLIENT_REVIEW',
      is_current = true,
      submitted_at = now(),
      expires_at = null
  where id = v_delivery.id
  returning * into v_delivery;

  select profile.name into v_client_name
  from public.profiles as profile
  where profile.id = v_delivery.artist_id;
  insert into public.notifications (
    recipient_id, notification_type, title, message, related_id, related_route
  )
  values (
    v_delivery.client_id,
    'commission',
    'Final Delivery Submitted',
    coalesce(v_client_name, 'Your artist') || ' submitted a Final Delivery for your commission.',
    v_commission.id,
    '/home/workspace/' || v_commission.id::text
  );

  return v_delivery;
end;
$$;

revoke all on function public.finalize_commission_final_delivery(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_commission_final_delivery(uuid, uuid, jsonb)
  to service_role;

create or replace function public.abandon_commission_final_delivery_upload(
  p_delivery_id uuid,
  p_actor_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  update public.commission_final_deliveries as delivery
  set status = 'ABANDONED'
  from public.commissions as commission
  where delivery.id = p_delivery_id
    and delivery.commission_id = commission.id
    and delivery.status = 'UPLOADING'
    and delivery.artist_id = p_actor_id
    and delivery.created_by = p_actor_id
    and commission.artist_id = p_actor_id;
  if not found then raise exception 'Final Delivery upload cannot be abandoned'; end if;
end;
$$;

revoke all on function public.abandon_commission_final_delivery_upload(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.abandon_commission_final_delivery_upload(uuid, uuid)
  to service_role;

create or replace function public.accept_commission_final_delivery(p_delivery_id uuid)
returns public.commission_final_deliveries
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_delivery public.commission_final_deliveries;
  v_commission public.commissions;
  v_client_name text;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  select profile.role, profile.name into v_role, v_client_name
  from public.profiles as profile
  where profile.id = v_user;
  if v_role is distinct from 'client' then
    raise exception 'Only Clients can accept Final Delivery';
  end if;

  select commission.* into v_commission
  from public.commissions as commission
  join public.commission_final_deliveries as delivery
    on delivery.commission_id = commission.id
  where delivery.id = p_delivery_id
  for update of commission;
  if not found then raise exception 'Final Delivery batch not found'; end if;
  if v_commission.client_id is distinct from v_user then
    raise exception 'Not authorized for this Final Delivery';
  end if;
  if v_commission.final_delivery_required is distinct from true then
    raise exception 'Final Delivery is not enabled for this commission';
  end if;
  if v_commission.status not in ('IN_PROGRESS', 'REVISION_REQUESTED') then
    raise exception 'Commission is not accepting Final Delivery review';
  end if;

  select delivery.* into v_delivery
  from public.commission_final_deliveries as delivery
  where delivery.id = p_delivery_id
  for update;
  if v_delivery.status is distinct from 'AWAITING_CLIENT_REVIEW'
    or not v_delivery.is_current then
    raise exception 'Only the current Final Delivery awaiting review can be accepted';
  end if;

  update public.commission_final_deliveries
  set status = 'ACCEPTED',
      decided_at = now(),
      decided_by = v_user
  where id = v_delivery.id
    and status = 'AWAITING_CLIENT_REVIEW'
  returning * into v_delivery;
  if not found then raise exception 'Final Delivery is no longer awaiting review'; end if;

  insert into public.notifications (
    recipient_id, notification_type, title, message, related_id, related_route
  )
  values (
    v_delivery.artist_id,
    'commission',
    'Final Delivery Accepted',
    coalesce(v_client_name, 'The client') || ' accepted your Final Delivery.',
    v_commission.id,
    '/home/workspace/' || v_commission.id::text
  );
  return v_delivery;
end;
$$;

revoke all on function public.accept_commission_final_delivery(uuid)
  from public, anon;
grant execute on function public.accept_commission_final_delivery(uuid)
  to authenticated;

create or replace function public.request_commission_final_revision(
  p_delivery_id uuid,
  p_reason text
)
returns public.commission_final_deliveries
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_delivery public.commission_final_deliveries;
  v_commission public.commissions;
  v_client_name text;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  if v_reason is null or length(v_reason) > 4000 then
    raise exception 'A Final Delivery revision reason is required';
  end if;
  select profile.role, profile.name into v_role, v_client_name
  from public.profiles as profile
  where profile.id = v_user;
  if v_role is distinct from 'client' then
    raise exception 'Only Clients can request a Final Delivery revision';
  end if;

  select commission.* into v_commission
  from public.commissions as commission
  join public.commission_final_deliveries as delivery
    on delivery.commission_id = commission.id
  where delivery.id = p_delivery_id
  for update of commission;
  if not found then raise exception 'Final Delivery batch not found'; end if;
  if v_commission.client_id is distinct from v_user then
    raise exception 'Not authorized for this Final Delivery';
  end if;
  if v_commission.final_delivery_required is distinct from true then
    raise exception 'Final Delivery is not enabled for this commission';
  end if;
  if v_commission.status not in ('IN_PROGRESS', 'REVISION_REQUESTED') then
    raise exception 'Commission is not accepting Final Delivery review';
  end if;

  select delivery.* into v_delivery
  from public.commission_final_deliveries as delivery
  where delivery.id = p_delivery_id
  for update;
  if v_delivery.status is distinct from 'AWAITING_CLIENT_REVIEW'
    or not v_delivery.is_current then
    raise exception 'Only the current Final Delivery awaiting review can be revised';
  end if;

  update public.commission_final_deliveries
  set status = 'REVISION_REQUESTED',
      decided_at = now(),
      decided_by = v_user,
      revision_reason = v_reason
  where id = v_delivery.id
    and status = 'AWAITING_CLIENT_REVIEW'
  returning * into v_delivery;
  if not found then raise exception 'Final Delivery is no longer awaiting review'; end if;

  insert into public.notifications (
    recipient_id, notification_type, title, message, related_id, related_route
  )
  values (
    v_delivery.artist_id,
    'commission',
    'Final Delivery Revision Requested',
    coalesce(v_client_name, 'The client') || ' requested a revision to your Final Delivery.',
    v_commission.id,
    '/home/workspace/' || v_commission.id::text
  );
  return v_delivery;
end;
$$;

revoke all on function public.request_commission_final_revision(uuid, text)
  from public, anon;
grant execute on function public.request_commission_final_revision(uuid, text)
  to authenticated;

create or replace function public.list_commission_final_deliveries(p_commission_id uuid)
returns table (
  delivery_id uuid,
  attempt_number integer,
  status text,
  is_current boolean,
  submitted_at timestamptz,
  decided_at timestamptz,
  revision_reason text,
  files jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null or not exists (
    select 1 from public.commissions as commission
    where commission.id = p_commission_id
      and (commission.artist_id = v_user or commission.client_id = v_user)
  ) then
    raise exception 'Not authorized for this commission';
  end if;

  return query
  select delivery.id,
         delivery.attempt_number,
         delivery.status,
         delivery.is_current,
         delivery.submitted_at,
         delivery.decided_at,
         delivery.revision_reason,
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'file_id', file.id,
             'filename', file.display_filename,
             'mime_type', file.verified_mime_type,
             'size_bytes', file.file_size_bytes
           ) order by file.created_at, file.id)
           from public.commission_final_delivery_files as file
           where file.delivery_id = delivery.id
             and file.verification_status = 'VERIFIED'
         ), '[]'::jsonb)
  from public.commission_final_deliveries as delivery
  where delivery.commission_id = p_commission_id
    and delivery.status not in ('UPLOADING', 'ABANDONED')
  order by delivery.attempt_number;
end;
$$;

revoke all on function public.list_commission_final_deliveries(uuid)
  from public, anon;
grant execute on function public.list_commission_final_deliveries(uuid)
  to authenticated;

create or replace function public.get_final_delivery_download_target(
  p_file_id uuid,
  p_actor_id uuid
)
returns table (
  storage_path text,
  display_filename text,
  mime_type text
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_actor_id is null then raise exception 'Not authorized for this Final Delivery file'; end if;
  return query
  select file.storage_path, file.display_filename, file.verified_mime_type
  from public.commission_final_delivery_files as file
  join public.commission_final_deliveries as delivery
    on delivery.id = file.delivery_id
  join public.commissions as commission
    on commission.id = delivery.commission_id
  where file.id = p_file_id
    and file.verification_status = 'VERIFIED'
    and delivery.status in ('AWAITING_CLIENT_REVIEW', 'REVISION_REQUESTED', 'ACCEPTED')
    and p_actor_id in (commission.artist_id, commission.client_id);
  if not found then raise exception 'Final Delivery file is not available'; end if;
end;
$$;

revoke all on function public.get_final_delivery_download_target(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_final_delivery_download_target(uuid, uuid)
  to service_role;

create or replace function public.get_final_delivery_batch_state(
  p_delivery_id uuid,
  p_actor_id uuid
)
returns table (status text, is_current boolean)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return query
  select delivery.status, delivery.is_current
  from public.commission_final_deliveries as delivery
  where delivery.id = p_delivery_id
    and delivery.artist_id = p_actor_id
    and delivery.created_by = p_actor_id;
  if not found then raise exception 'Final Delivery batch not found'; end if;
end;
$$;

revoke all on function public.get_final_delivery_batch_state(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_final_delivery_batch_state(uuid, uuid)
  to service_role;

create or replace function public.claim_expired_final_delivery_uploads()
returns table (delivery_id uuid, storage_paths text[])
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the storage cleanup worker can claim expired uploads';
  end if;

  update public.commission_final_deliveries as delivery
  set status = 'ABANDONED'
  where delivery.status = 'UPLOADING'
    and delivery.expires_at <= now()
    and delivery.cleanup_completed_at is null;

  return query
  select delivery.id, coalesce(array_agg(file.storage_path), array[]::text[])
  from public.commission_final_deliveries as delivery
  left join public.commission_final_delivery_files as file
    on file.delivery_id = delivery.id
  where delivery.status = 'ABANDONED'
    and delivery.cleanup_completed_at is null
  group by delivery.id
  order by delivery.id;
end;
$$;

create or replace function public.complete_final_delivery_storage_cleanup(p_delivery_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the storage cleanup worker can finish cleanup';
  end if;
  update public.commission_final_deliveries
  set cleanup_completed_at = now()
  where id = p_delivery_id
    and status = 'ABANDONED'
    and cleanup_completed_at is null;
  if not found then raise exception 'Expired Final Delivery batch is not awaiting cleanup'; end if;
end;
$$;

revoke all on function public.claim_expired_final_delivery_uploads()
  from public, anon, authenticated;
revoke all on function public.complete_final_delivery_storage_cleanup(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_expired_final_delivery_uploads()
  to service_role;
grant execute on function public.complete_final_delivery_storage_cleanup(uuid)
  to service_role;

create or replace function public.complete_commission(p_commission_id uuid)
returns table (commission_id uuid, status text, completed_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_client_name text;
  v_commission public.commissions;
  v_completed_at timestamptz;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;

  select p.role, p.name
  into v_role, v_client_name
  from public.profiles as p
  where p.id = v_user;
  if v_role is distinct from 'client' then
    raise exception 'Only clients can complete commissions';
  end if;

  select c.*
  into v_commission
  from public.commissions as c
  where c.id = p_commission_id
  for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_commission.client_id is distinct from v_user then
    raise exception 'Not authorized for this commission';
  end if;
  if v_commission.status not in ('IN_PROGRESS', 'REVISION_REQUESTED') then
    raise exception 'Commission cannot be completed in its current state';
  end if;

  if not exists (
    select 1 from public.commission_milestones as m
    where m.commission_id = v_commission.id
  ) then
    raise exception 'Commission must have milestones before completion';
  end if;
  if exists (
    select 1 from public.commission_milestones as m
    where m.commission_id = v_commission.id
      and m.status <> 'APPROVED'
  ) then
    raise exception 'All milestones must be approved before completion';
  end if;

  if not exists (
    select 1 from public.commission_deliverables as d
    where d.commission_id = v_commission.id
      and d.status = 'APPROVED'
  ) then
    raise exception 'Commission requires at least one approved deliverable before completion';
  end if;

  if exists (
    select 1 from public.commission_deliverables as d
    where d.commission_id = v_commission.id
      and d.status is distinct from 'APPROVED'
      and d.status is distinct from 'FAILED'
  ) then
    raise exception 'All active deliverables must be approved before completion';
  end if;

  if exists (
    select 1 from public.revision_requests as r
    where r.commission_id = v_commission.id
      and r.status in ('OPEN', 'IN_PROGRESS', 'SUBMITTED')
  ) then
    raise exception 'Resolve all revision requests before completion';
  end if;

  if v_commission.final_delivery_required
    and not exists (
      select 1
      from public.commission_final_deliveries as delivery
      where delivery.commission_id = v_commission.id
        and delivery.is_current
        and delivery.status = 'ACCEPTED'
    ) then
    raise exception 'Final Delivery must be accepted before completion';
  end if;

  v_completed_at := now();
  update public.commissions as c
  set status = 'COMPLETED',
      completed_at = v_completed_at,
      completed_by = v_user
  where c.id = v_commission.id
    and c.status in ('IN_PROGRESS', 'REVISION_REQUESTED')
  returning c.* into v_commission;
  if not found then
    raise exception 'Commission was already completed or is no longer active';
  end if;

  insert into public.notifications (
    recipient_id, notification_type, title, message, related_id, related_route
  )
  values (
    v_commission.artist_id,
    'commission',
    'Commission Completed',
    coalesce(v_client_name, 'The client') || ' completed the commission "' || v_commission.title || '".',
    v_commission.id,
    '/home/workspace/' || v_commission.id::text
  );

  return query select v_commission.id, v_commission.status, v_completed_at;
end;
$$;

revoke all on function public.complete_commission(uuid)
  from public, anon, authenticated;
grant execute on function public.complete_commission(uuid)
  to authenticated;


commit;
