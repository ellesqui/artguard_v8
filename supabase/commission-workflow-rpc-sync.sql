-- Forward-only commission workflow synchronization.
-- Adds revision/deliverable linkage, keeps revision inserts RPC-only, and
-- makes revised submissions, approvals, and completion gates consistent.
-- Review before applying to the target database; this file is not applied here.

begin;

alter table public.revision_requests
  add column if not exists response_deliverable_id uuid
  references public.commission_deliverables(id) on delete set null;

create index if not exists revision_requests_response_deliverable_idx
  on public.revision_requests(response_deliverable_id, created_at desc);

drop policy if exists "client can create their own revision request"
  on public.revision_requests;
revoke insert on public.revision_requests from public, anon, authenticated;
grant select on public.revision_requests to authenticated;

create or replace function public.create_revision_request(
  p_commission_id uuid,
  p_description text
)
returns public.revision_requests
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return public.create_revision_request(p_commission_id, null, p_description);
end;
$$;

create or replace function public.create_revision_request(
  p_commission_id uuid,
  p_deliverable_id uuid,
  p_description text
)
returns public.revision_requests
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_client_name text;
  v_commission public.commissions;
  v_deliverable public.commission_deliverables;
  v_row public.revision_requests;
  v_description text := nullif(btrim(p_description), '');
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  if v_description is null then raise exception 'Description cannot be empty'; end if;

  select p.role, p.name
  into v_role, v_client_name
  from public.profiles as p
  where p.id = v_user;
  if v_role is distinct from 'client' then
    raise exception 'Only clients can create revision requests';
  end if;

  select c.*
  into v_commission
  from public.commissions as c
  where c.id = p_commission_id
  for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_commission.client_id is distinct from v_user then
    raise exception 'Only the client can create a revision request';
  end if;
  if v_commission.status is distinct from 'IN_PROGRESS' then
    raise exception 'Commission must be in progress to request a revision';
  end if;
  if exists (
    select 1
    from public.revision_requests as r
    where r.commission_id = v_commission.id
      and r.status in ('OPEN', 'IN_PROGRESS', 'SUBMITTED')
  ) then
    raise exception 'A revision request is already active';
  end if;

  if p_deliverable_id is not null then
    select d.*
    into v_deliverable
    from public.commission_deliverables as d
    where d.id = p_deliverable_id
      and d.commission_id = v_commission.id
    for update;
    if not found or v_deliverable.status is distinct from 'SUBMITTED' then
      raise exception 'Only a submitted deliverable can be revised';
    end if;
    if exists (
      select 1
      from public.commission_deliverables as newer
      where newer.commission_id = v_commission.id
        and newer.status = 'SUBMITTED'
        and (newer.created_at, newer.id) > (v_deliverable.created_at, v_deliverable.id)
    ) then
      raise exception 'Only the latest submitted deliverable can be revised';
    end if;
  end if;

  insert into public.revision_requests (
    commission_id, deliverable_id, client_id, artist_id, description, status
  )
  values (
    v_commission.id, p_deliverable_id, v_commission.client_id,
    v_commission.artist_id, v_description, 'OPEN'
  )
  returning * into v_row;

  update public.commissions
  set status = 'REVISION_REQUESTED'
  where id = v_commission.id
    and status = 'IN_PROGRESS';
  if not found then raise exception 'Commission is no longer in progress'; end if;

  insert into public.notifications (
    recipient_id, notification_type, title, message, related_id, related_route
  )
  values (
    v_commission.artist_id,
    'commission',
    'Revision Requested',
    coalesce(v_client_name, 'The client') || ' requested a revision for your commission deliverable.',
    v_commission.id,
    '/home/workspace/' || v_commission.id::text
  );
  return v_row;
end;
$$;

revoke all on function public.create_revision_request(uuid, text)
  from public, anon, authenticated;
grant execute on function public.create_revision_request(uuid, text)
  to authenticated;
revoke all on function public.create_revision_request(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.create_revision_request(uuid, uuid, text)
  to authenticated;

create or replace function public.set_revision_status(
  p_revision_id uuid,
  p_status text,
  p_response_text text default null
)
returns public.revision_requests
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_row public.revision_requests;
  v_commission public.commissions;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  if p_status is null or p_status not in ('IN_PROGRESS', 'SUBMITTED', 'RESOLVED') then
    raise exception 'Invalid status';
  end if;

  select r.*
  into v_row
  from public.revision_requests as r
  where r.id = p_revision_id
  for update;
  if not found then raise exception 'Revision request not found'; end if;

  select c.*
  into v_commission
  from public.commissions as c
  where c.id = v_row.commission_id
  for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_commission.status in ('CANCELLED', 'COMPLETED') then
    raise exception 'Closed commissions do not accept revision changes';
  end if;

  select p.role into v_role
  from public.profiles as p
  where p.id = v_user;

  if p_status = 'IN_PROGRESS' then
    if v_user is distinct from v_row.artist_id
      or v_role is distinct from 'artist'
      or v_row.status is distinct from 'OPEN'
      or v_commission.status is distinct from 'REVISION_REQUESTED' then
      raise exception 'Invalid status transition';
    end if;
    update public.revision_requests
    set status = 'IN_PROGRESS'
    where id = p_revision_id
    returning * into v_row;
  elsif p_status = 'SUBMITTED' then
    if v_user is distinct from v_row.artist_id
      or v_role is distinct from 'artist'
      or v_row.status is distinct from 'IN_PROGRESS' then
      raise exception 'Invalid status transition';
    end if;
    if length(btrim(coalesce(p_response_text, ''))) = 0 then
      raise exception 'A response is required to submit this revision';
    end if;
    update public.revision_requests
    set status = 'SUBMITTED',
        response_text = btrim(p_response_text)
    where id = p_revision_id
    returning * into v_row;
  elsif p_status = 'RESOLVED' then
    if v_user is distinct from v_row.client_id
      or v_role is distinct from 'client'
      or v_row.status is distinct from 'SUBMITTED' then
      raise exception 'Invalid status transition';
    end if;
    update public.revision_requests
    set status = 'RESOLVED'
    where id = p_revision_id
    returning * into v_row;
    update public.commissions
    set status = 'IN_PROGRESS'
    where id = v_commission.id
      and status = 'REVISION_REQUESTED'
      and not exists (
        select 1
        from public.revision_requests as active_revision
        where active_revision.commission_id = v_commission.id
          and active_revision.id <> v_row.id
          and active_revision.status in ('OPEN', 'IN_PROGRESS', 'SUBMITTED')
      );
  end if;

  return v_row;
end;
$$;

revoke all on function public.set_revision_status(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.set_revision_status(uuid, text, text)
  to authenticated;

create or replace function public.submit_commission_deliverable(
  p_deliverable_id uuid,
  p_protected_storage_path text
)
returns public.commission_deliverables
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_row public.commission_deliverables;
  v_commission public.commissions;
  v_revision public.revision_requests;
  v_artist_name text;
  v_was_revision boolean;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;

  select d.*
  into v_row
  from public.commission_deliverables as d
  where d.id = p_deliverable_id
  for update;
  if not found then raise exception 'Deliverable not found'; end if;
  if v_row.artist_id is distinct from v_user then
    raise exception 'Not authorized for this deliverable';
  end if;

  select c.*
  into v_commission
  from public.commissions as c
  where c.id = v_row.commission_id
  for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_commission.artist_id is distinct from v_user then
    raise exception 'Not authorized for this commission';
  end if;
  if v_commission.status not in ('IN_PROGRESS', 'REVISION_REQUESTED') then
    raise exception 'Commission is not accepting deliverables';
  end if;
  if v_row.status is distinct from 'PROCESSING' then
    raise exception 'Deliverable is not processing';
  end if;

  select p.role, p.name
  into v_role, v_artist_name
  from public.profiles as p
  where p.id = v_user;
  if v_role is distinct from 'artist' then raise exception 'Only artists can submit deliverables'; end if;
  if p_protected_storage_path is null
    or p_protected_storage_path not like v_user::text || '/commissions/' || v_row.commission_id::text || '/protected/%' then
    raise exception 'Invalid protected deliverable path';
  end if;

  v_was_revision := v_commission.status = 'REVISION_REQUESTED';
  update public.commission_deliverables
  set protected_storage_path = p_protected_storage_path,
      status = 'SUBMITTED',
      submitted_at = now()
  where id = v_row.id
    and status = 'PROCESSING'
  returning * into v_row;
  if not found then raise exception 'Deliverable is no longer processing'; end if;

  if v_was_revision then
    select r.*
    into v_revision
    from public.revision_requests as r
    where r.commission_id = v_commission.id
      and r.status in ('OPEN', 'IN_PROGRESS')
    order by r.created_at desc, r.id desc
    limit 1
    for update;
    if found then
      update public.revision_requests
      set status = 'SUBMITTED',
          response_text = coalesce(nullif(btrim(v_row.description), ''), 'Revised deliverable submitted.'),
          response_deliverable_id = v_row.id
      where id = v_revision.id;
    end if;

    update public.commissions
    set status = 'IN_PROGRESS'
    where id = v_commission.id
      and status = 'REVISION_REQUESTED';
  end if;

  insert into public.notifications (
    recipient_id, notification_type, title, message, related_id, related_route
  )
  values (
    v_commission.client_id,
    'commission',
    case when v_was_revision then 'Revised Deliverable Submitted' else 'New Deliverable Submitted' end,
    coalesce(v_artist_name, 'Your artist') ||
      case when v_was_revision
        then ' submitted revised work for your commission.'
        else ' submitted a new deliverable for your commission.'
      end,
    v_commission.id,
    '/home/workspace/' || v_commission.id::text
  );
  return v_row;
end;
$$;

revoke all on function public.submit_commission_deliverable(uuid, text)
  from public, anon, authenticated;
grant execute on function public.submit_commission_deliverable(uuid, text)
  to authenticated;

create or replace function public.approve_commission_deliverable(p_deliverable_id uuid)
returns public.commission_deliverables
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_row public.commission_deliverables;
  v_commission public.commissions;
  v_client_name text;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;

  select p.role, p.name
  into v_role, v_client_name
  from public.profiles as p
  where p.id = v_user;
  if v_role is distinct from 'client' then
    raise exception 'Only clients can approve deliverables';
  end if;

  select d.*
  into v_row
  from public.commission_deliverables as d
  where d.id = p_deliverable_id
  for update;
  if not found then raise exception 'Deliverable not found'; end if;

  select c.*
  into v_commission
  from public.commissions as c
  where c.id = v_row.commission_id
  for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_commission.client_id is distinct from v_user then
    raise exception 'Not authorized for this deliverable';
  end if;
  if v_commission.status in ('CANCELLED', 'COMPLETED') then
    raise exception 'Closed commissions do not accept deliverable approval';
  end if;
  if v_row.status is distinct from 'SUBMITTED' then
    raise exception 'Only submitted deliverables can be approved';
  end if;

  update public.commission_deliverables
  set status = 'APPROVED',
      approved_at = now()
  where id = p_deliverable_id
    and status = 'SUBMITTED'
  returning * into v_row;
  if not found then raise exception 'Deliverable is no longer submitted'; end if;

  update public.revision_requests
  set status = 'RESOLVED'
  where response_deliverable_id = v_row.id
    and commission_id = v_commission.id
    and client_id = v_user
    and status = 'SUBMITTED';

  insert into public.notifications (
    recipient_id, notification_type, title, message, related_id, related_route
  )
  values (
    v_commission.artist_id,
    'commission',
    'Deliverable Approved',
    coalesce(v_client_name, 'The client') || ' approved your commission deliverable.',
    v_commission.id,
    '/home/workspace/' || v_commission.id::text
  );
  return v_row;
end;
$$;

revoke all on function public.approve_commission_deliverable(uuid)
  from public, anon, authenticated;
grant execute on function public.approve_commission_deliverable(uuid)
  to authenticated;

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
