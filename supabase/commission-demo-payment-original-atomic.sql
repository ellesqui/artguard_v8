-- Original-project-only additive simulated payment flow.
-- Adds a durable demo marker and an atomic client-owned payment RPC.
-- No real payment provider or money movement is involved.

begin;

set local lock_timeout = '5s';

do $preflight$
declare
  v_missing_columns text;
begin
  if to_regclass('public.profiles') is null
    or to_regclass('public.commissions') is null
    or to_regclass('public.commission_payments') is null then
    raise exception 'Payment migration preflight failed: expected Original payment relations are missing';
  end if;

  select string_agg(format('%s.%s expected %s', expected.table_name, expected.column_name, expected.udt_name), ', ')
  into v_missing_columns
  from (values
    ('profiles', 'id', 'uuid'),
    ('profiles', 'role', 'text'),
    ('commissions', 'id', 'uuid'),
    ('commissions', 'client_id', 'uuid'),
    ('commissions', 'artist_id', 'uuid'),
    ('commissions', 'status', 'text'),
    ('commissions', 'amount', 'numeric'),
    ('commissions', 'currency', 'text'),
    ('commission_payments', 'id', 'uuid'),
    ('commission_payments', 'commission_id', 'uuid'),
    ('commission_payments', 'payer_id', 'uuid'),
    ('commission_payments', 'payee_id', 'uuid'),
    ('commission_payments', 'amount', 'numeric'),
    ('commission_payments', 'currency', 'text'),
    ('commission_payments', 'status', 'text'),
    ('commission_payments', 'provider', 'text'),
    ('commission_payments', 'provider_reference', 'text'),
    ('commission_payments', 'created_at', 'timestamptz'),
    ('commission_payments', 'paid_at', 'timestamptz'),
    ('commission_payments', 'created_by', 'uuid')
  ) as expected(table_name, column_name, udt_name)
  left join information_schema.columns as actual
    on actual.table_schema = 'public'
    and actual.table_name = expected.table_name
    and actual.column_name = expected.column_name
  where actual.column_name is null
    or actual.udt_name <> expected.udt_name;

  if v_missing_columns is not null then
    raise exception 'Payment migration preflight failed: incompatible columns: %', v_missing_columns;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'commission_payments'
      and column_name = 'demo_paid_at'
  ) then
    raise exception 'Payment migration preflight failed: demo_paid_at already exists; inspect before continuing';
  end if;

  if to_regprocedure('public.simulate_commission_payment_demo_success(uuid)') is not null then
    raise exception 'Payment migration preflight failed: simulated payment RPC signature already exists';
  end if;

  if to_regprocedure('public.simulate_commission_payment_success(uuid)') is null then
    raise exception 'Payment migration preflight failed: expected legacy payment RPC is missing';
  end if;

  if not exists (
    select 1
    from pg_class as relation
    where relation.oid = 'public.commission_payments'::regclass
      and relation.relrowsecurity
  ) then
    raise exception 'Payment migration preflight failed: commission_payments RLS is not enabled';
  end if;

  if has_table_privilege('anon', 'public.commission_payments', 'INSERT')
    or has_table_privilege('anon', 'public.commission_payments', 'UPDATE')
    or has_table_privilege('anon', 'public.commission_payments', 'DELETE')
    or has_table_privilege('authenticated', 'public.commission_payments', 'INSERT')
    or has_table_privilege('authenticated', 'public.commission_payments', 'UPDATE')
    or has_table_privilege('authenticated', 'public.commission_payments', 'DELETE') then
    raise exception 'Payment migration preflight failed: client roles have direct payment table write privileges';
  end if;

  if not exists (
    select 1
    from pg_index as payment_index
    join pg_class as index_relation on index_relation.oid = payment_index.indexrelid
    where payment_index.indrelid = 'public.commission_payments'::regclass
      and payment_index.indisunique
      and index_relation.relname = 'commission_payments_one_active_per_commission_idx'
      and pg_get_indexdef(payment_index.indexrelid) ilike '%(commission_id)%'
      and pg_get_expr(payment_index.indpred, payment_index.indrelid) ilike '%PENDING%'
      and pg_get_expr(payment_index.indpred, payment_index.indrelid) ilike '%PAID%'
  ) then
    raise exception 'Payment migration preflight failed: expected one-active-payment-per-commission index is missing or different';
  end if;

  if not exists (
    select 1
    from pg_constraint as payment_constraint
    where payment_constraint.conrelid = 'public.commission_payments'::regclass
      and payment_constraint.conname = 'commission_payments_status_check'
      and pg_get_constraintdef(payment_constraint.oid) ilike '%PENDING%'
      and pg_get_constraintdef(payment_constraint.oid) ilike '%PAID%'
      and pg_get_constraintdef(payment_constraint.oid) ilike '%FAILED%'
      and pg_get_constraintdef(payment_constraint.oid) ilike '%REFUNDED%'
      and pg_get_constraintdef(payment_constraint.oid) ilike '%VOIDED%'
  ) then
    raise exception 'Payment migration preflight failed: commission_payments status constraint differs';
  end if;

  if not exists (
    select 1
    from pg_constraint as commission_constraint
    where commission_constraint.conrelid = 'public.commissions'::regclass
      and commission_constraint.conname = 'commissions_status_check'
      and pg_get_constraintdef(commission_constraint.oid) ilike '%ACCEPTED%'
      and pg_get_constraintdef(commission_constraint.oid) ilike '%CANCELLED%'
  ) then
    raise exception 'Payment migration preflight failed: commissions status constraint differs';
  end if;

  if not exists (
    select 1
    from pg_constraint as payment_fk
    where payment_fk.conrelid = 'public.commission_payments'::regclass
      and payment_fk.conname = 'commission_payments_commission_id_fkey'
      and payment_fk.contype = 'f'
      and pg_get_constraintdef(payment_fk.oid) ilike '%REFERENCES commissions(id)%'
  ) then
    raise exception 'Payment migration preflight failed: commission payment relationship differs';
  end if;

  if not has_table_privilege('authenticated', 'public.commission_payments', 'SELECT')
    or not has_table_privilege('authenticated', 'public.commissions', 'SELECT')
    or has_table_privilege('anon', 'public.commission_payments', 'SELECT') then
    raise exception 'Payment migration preflight failed: expected authenticated payment reads are not configured';
  end if;

  if not exists (
    select 1
    from pg_policies as payment_policy
    where payment_policy.schemaname = 'public'
      and payment_policy.tablename = 'commission_payments'
      and payment_policy.policyname = 'commission parties can read their payments'
      and payment_policy.cmd = 'SELECT'
  ) then
    raise exception 'Payment migration preflight failed: commission payment owner-read policy differs';
  end if;

  if exists (
    select 1
    from pg_constraint as payment_constraint
    where payment_constraint.conrelid = 'public.commission_payments'::regclass
      and payment_constraint.conname = 'commission_payments_demo_marker_check'
  ) then
    raise exception 'Payment migration preflight failed: demo marker constraint name is already in use';
  end if;
end;
$preflight$;

alter table public.commission_payments
  add column demo_paid_at timestamptz;

revoke insert (demo_paid_at), update (demo_paid_at)
  on table public.commission_payments from public, anon, authenticated;

alter table public.commission_payments
  add constraint commission_payments_demo_marker_check
  check (
    demo_paid_at is null
    or (
      status in ('PAID', 'REFUNDED')
      and provider = 'DEMO_SIMULATION'
      and provider_reference is null
      and paid_at is not null
    )
  );

create function public.simulate_commission_payment_demo_success(p_commission_id uuid)
returns public.commission_payments
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_commission public.commissions;
  v_payment public.commission_payments;
  v_payment_found boolean;
  v_paid_at timestamptz := now();
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  select profile.role
  into v_role
  from public.profiles as profile
  where profile.id = v_user;
  if v_role is distinct from 'client' then
    raise exception 'Only client accounts can simulate commission payment';
  end if;

  select commission.*
  into v_commission
  from public.commissions as commission
  where commission.id = p_commission_id
  for update;
  if not found then
    raise exception 'Commission not found';
  end if;
  if v_commission.client_id is distinct from v_user then
    raise exception 'Only the commission Client can pay this commission';
  end if;
  if v_commission.amount is null
    or v_commission.amount <= 0
    or v_commission.amount::text in ('NaN', 'Infinity', '-Infinity')
    or v_commission.currency is null
    or v_commission.currency !~ '^[A-Z]{3}$' then
    raise exception 'COMMISSION_PRICE_UNAVAILABLE';
  end if;
  if not exists (
    select 1
    from public.profiles as artist
    where artist.id = v_commission.artist_id
      and artist.role = 'artist'
  ) then
    raise exception 'Commission Artist not found';
  end if;

  select payment.*
  into v_payment
  from public.commission_payments as payment
  where payment.commission_id = v_commission.id
    and payment.status in ('PENDING', 'PAID')
  order by payment.created_at desc
  limit 1
  for update;
  v_payment_found := found;

  if v_payment_found then
    if v_payment.payer_id is distinct from v_commission.client_id
      or v_payment.payee_id is distinct from v_commission.artist_id
      or v_payment.amount is distinct from v_commission.amount
      or v_payment.currency is distinct from v_commission.currency then
      raise exception 'Payment does not match the commission participants and agreed price';
    end if;

    if v_payment.status = 'PAID'
      and v_payment.provider = 'DEMO_SIMULATION'
      and v_payment.provider_reference is null
      and v_payment.paid_at is not null
      and v_payment.demo_paid_at is not null then
      return v_payment;
    end if;

    if v_payment.status <> 'PENDING' then
      raise exception 'This commission already has a non-demo settled payment';
    end if;
    if v_payment.provider is not null
      or v_payment.provider_reference is not null
      or v_payment.demo_paid_at is not null then
      raise exception 'Provider-associated payment records cannot use demo simulation';
    end if;
  end if;

  if v_commission.status = 'CANCELLED' then
    raise exception 'COMMISSION_CANCELLED';
  end if;
  if v_commission.status <> 'ACCEPTED' then
    raise exception 'Only accepted commissions can be paid';
  end if;

  if not v_payment_found then
    insert into public.commission_payments (
      commission_id,
      payer_id,
      payee_id,
      amount,
      currency,
      status,
      created_by
    )
    values (
      v_commission.id,
      v_commission.client_id,
      v_commission.artist_id,
      v_commission.amount,
      v_commission.currency,
      'PENDING',
      v_user
    )
    returning * into v_payment;
  end if;

  update public.commission_payments as payment
  set status = 'PAID',
      provider = 'DEMO_SIMULATION',
      paid_at = v_paid_at,
      demo_paid_at = v_paid_at
  where payment.id = v_payment.id
    and payment.status = 'PENDING'
    and payment.provider is null
    and payment.provider_reference is null
    and payment.demo_paid_at is null
  returning payment.* into v_payment;
  if not found then
    raise exception 'Payment is no longer eligible for simulated success';
  end if;

  return v_payment;
end;
$function$;

alter function public.simulate_commission_payment_demo_success(uuid) owner to postgres;
revoke all on function public.simulate_commission_payment_demo_success(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.simulate_commission_payment_demo_success(uuid)
  to authenticated;

-- Keep the older, less constrained success RPC out of browser reach.
revoke all on function public.simulate_commission_payment_success(uuid)
  from public, anon, authenticated;
grant execute on function public.simulate_commission_payment_success(uuid)
  to service_role;

do $verify$
declare
  v_function oid := to_regprocedure('public.simulate_commission_payment_demo_success(uuid)');
begin
  if v_function is null
    or (select procedure.prorettype from pg_proc as procedure where procedure.oid = v_function)
      <> 'public.commission_payments'::regtype
    or not (select procedure.prosecdef from pg_proc as procedure where procedure.oid = v_function)
    or (select procedure.proowner from pg_proc as procedure where procedure.oid = v_function)
      <> 'postgres'::regrole
    or not exists (
      select 1
      from pg_proc as procedure
      where procedure.oid = v_function
        and array_to_string(procedure.proconfig, ',') like '%search_path=pg_catalog, pg_temp%'
    ) then
    raise exception 'Payment migration verification failed: demo RPC definition or trusted ownership differs';
  end if;

  if not has_function_privilege('authenticated', v_function, 'EXECUTE')
    or has_function_privilege('anon', v_function, 'EXECUTE')
    or has_function_privilege('service_role', v_function, 'EXECUTE') then
    raise exception 'Payment migration verification failed: demo RPC EXECUTE grants differ';
  end if;

  if has_function_privilege('authenticated', 'public.simulate_commission_payment_success(uuid)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.simulate_commission_payment_success(uuid)', 'EXECUTE')
    or has_table_privilege('authenticated', 'public.commission_payments', 'INSERT')
    or has_table_privilege('authenticated', 'public.commission_payments', 'UPDATE')
    or has_column_privilege('authenticated', 'public.commission_payments', 'demo_paid_at', 'INSERT')
    or has_column_privilege('authenticated', 'public.commission_payments', 'demo_paid_at', 'UPDATE') then
    raise exception 'Payment migration verification failed: legacy RPC or direct-write privileges are unsafe';
  end if;

  if not exists (
    select 1
    from information_schema.columns as demo_marker
    where demo_marker.table_schema = 'public'
      and demo_marker.table_name = 'commission_payments'
      and demo_marker.column_name = 'demo_paid_at'
      and demo_marker.udt_name = 'timestamptz'
  ) or not exists (
    select 1
    from pg_constraint as marker_constraint
    where marker_constraint.conrelid = 'public.commission_payments'::regclass
      and marker_constraint.conname = 'commission_payments_demo_marker_check'
  ) then
    raise exception 'Payment migration verification failed: demo marker column or integrity constraint is missing';
  end if;
end;
$verify$;

commit;
