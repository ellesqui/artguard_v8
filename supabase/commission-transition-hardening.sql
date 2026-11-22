-- Forward-only commission transition hardening.
-- Apply after the current commission request, deliverable, milestone,
-- cancellation, completion, and payment migrations have been reviewed.

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

  if v_row.commission_id is distinct from v_commission.id then
    raise exception 'Deliverable commission changed';
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

create or replace function public.approve_commission_milestone(p_milestone_id uuid)
returns public.commission_milestones
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_milestone public.commission_milestones;
  v_commission public.commissions;
  v_client_name text;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;

  select p.role, p.name
  into v_role, v_client_name
  from public.profiles as p
  where p.id = v_user;
  if v_role is distinct from 'client' then
    raise exception 'Only clients can approve milestones';
  end if;

  select m.*
  into v_milestone
  from public.commission_milestones as m
  where m.id = p_milestone_id
  for update;
  if not found then raise exception 'Milestone not found'; end if;

  select c.*
  into v_commission
  from public.commissions as c
  where c.id = v_milestone.commission_id
  for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_commission.client_id is distinct from v_user then
    raise exception 'Not authorized for this commission';
  end if;
  if v_commission.status not in ('IN_PROGRESS', 'REVISION_REQUESTED') then
    raise exception 'Commission is not accepting milestone approval';
  end if;

  if v_milestone.commission_id is distinct from v_commission.id then
    raise exception 'Milestone commission changed';
  end if;
  if v_milestone.status is distinct from 'SUBMITTED' then
    raise exception 'Only submitted milestones can be approved';
  end if;

  update public.commission_milestones
  set status = 'APPROVED',
      approved_at = now()
  where id = v_milestone.id
    and status = 'SUBMITTED'
  returning * into v_milestone;
  if not found then raise exception 'Milestone is no longer submitted'; end if;

  insert into public.notifications (
    recipient_id, notification_type, title, message, related_id, related_route
  )
  values (
    v_commission.artist_id,
    'commission',
    'Milestone Approved',
    coalesce(v_client_name, 'The client') || ' approved the ' || v_milestone.name || ' milestone.',
    v_commission.id,
    '/home/workspace/' || v_commission.id::text
  );

  return v_milestone;
end;
$$;

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
    select 1
    from public.commission_milestones as m
    where m.commission_id = v_commission.id
  ) then
    raise exception 'Commission must have milestones before completion';
  end if;
  if exists (
    select 1
    from public.commission_milestones as m
    where m.commission_id = v_commission.id
      and m.status <> 'APPROVED'
  ) then
    raise exception 'All milestones must be approved before completion';
  end if;

  if exists (
    select 1
    from public.commission_deliverables as d
    where d.commission_id = v_commission.id
      and d.status <> 'APPROVED'
  ) then
    raise exception 'All deliverables must be approved before completion';
  end if;

  if exists (
    select 1
    from public.revision_requests as r
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

  return query
  select v_commission.id, v_commission.status, v_completed_at;
end;
$$;

-- These operations already serialize on the commission or payment row. Fix
-- their SECURITY DEFINER lookup path without changing valid state transitions.
alter function public.accept_commission_request(uuid)
  set search_path = pg_catalog, public, pg_temp;
alter function public.start_commission(uuid)
  set search_path = pg_catalog, public, pg_temp;
alter function public.cancel_commission(uuid, text)
  set search_path = pg_catalog, public, pg_temp;
alter function public.create_commission_payment(uuid)
  set search_path = pg_catalog, public, pg_temp;
alter function public.simulate_commission_payment_success(uuid)
  set search_path = pg_catalog, public, pg_temp;
alter function public.simulate_commission_payment_failure(uuid)
  set search_path = pg_catalog, public, pg_temp;
alter function public.simulate_commission_payment_refund(uuid)
  set search_path = pg_catalog, public, pg_temp;

create or replace function public.reject_cancelled_commission_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_commission_id uuid;
  v_status text;
begin
  for v_commission_id in
    select candidate.id
    from (
      select new.commission_id as id
      union
      select case when tg_op = 'UPDATE' then old.commission_id end
    ) as candidate
    where candidate.id is not null
    order by candidate.id
  loop
    select c.status
    into v_status
    from public.commissions as c
    where c.id = v_commission_id
    for update;

    if found and v_status in ('CANCELLED', 'COMPLETED') then
      raise exception 'Closed commissions do not accept new workflow actions';
    end if;
  end loop;

  return new;
end;
$$;
