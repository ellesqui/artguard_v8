-- Serialize default milestone initialization on the commission row so two
-- concurrent starts cannot insert duplicate milestone sets.

begin;

create or replace function public.create_default_commission_milestones(p_commission_id uuid)
returns setof public.commission_milestones
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_commission public.commissions;
  v_count integer;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;

  select p.role into v_role
  from public.profiles as p
  where p.id = v_user;
  if v_role is distinct from 'artist' then
    raise exception 'Only artists can create milestones';
  end if;

  select c.*
  into v_commission
  from public.commissions as c
  where c.id = p_commission_id
  for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_commission.artist_id is distinct from v_user then
    raise exception 'Not authorized for this commission';
  end if;
  if v_commission.status not in ('ACCEPTED', 'IN_PROGRESS') then
    raise exception 'Commission is not ready for milestones';
  end if;

  select count(*) into v_count
  from public.commission_milestones as m
  where m.commission_id = p_commission_id;

  if v_count = 0 then
    insert into public.commission_milestones (commission_id, name, sort_order)
    values
      (p_commission_id, 'Thumbnail', 1),
      (p_commission_id, 'Sketch', 2),
      (p_commission_id, 'Line Art', 3),
      (p_commission_id, 'Final Render', 4);
  end if;

  return query
  select m.*
  from public.commission_milestones as m
  where m.commission_id = p_commission_id
  order by m.sort_order asc;
end;
$$;

revoke all on function public.create_default_commission_milestones(uuid)
  from public, anon, authenticated;
grant execute on function public.create_default_commission_milestones(uuid)
  to authenticated;

commit;
