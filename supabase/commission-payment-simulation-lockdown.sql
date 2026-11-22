-- Disable client-forged payment success. Apply after the latest payment RPC
-- definition/grants, including commission-payment-cancellation-coordination.sql.
-- Also apply after the current start_commission(uuid) payment guard.
begin;

-- Existing PAID rows are not assumed to be provider-verified. The marker is
-- left NULL until a future trusted payment integration can set it.
alter table public.commission_payments
  add column if not exists provider_verified_at timestamptz;

-- Clients may read payment history but cannot write payment state directly.
revoke insert, update, delete on table public.commission_payments
  from public, anon, authenticated;
revoke insert (
  id, commission_id, payer_id, payee_id, amount, currency, status, provider,
  provider_reference, created_at, paid_at, refunded_at, refunded_amount,
  created_by, voided_at, provider_verified_at
) on table public.commission_payments from public, anon, authenticated;
revoke update (
  id, commission_id, payer_id, payee_id, amount, currency, status, provider,
  provider_reference, created_at, paid_at, refunded_at, refunded_amount,
  created_by, voided_at, provider_verified_at
) on table public.commission_payments from public, anon, authenticated;

revoke execute on function public.simulate_commission_payment_success(uuid)
  from public, anon, authenticated;
grant execute on function public.simulate_commission_payment_success(uuid)
  to service_role;
alter function public.simulate_commission_payment_success(uuid)
  set search_path = pg_catalog, public, pg_temp;

create or replace function public.require_verified_payment_before_commission_start()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.status = 'IN_PROGRESS'
    and old.status is distinct from 'IN_PROGRESS'
    and (new.service_id is not null or new.public_post_id is not null)
    and not exists (
      select 1
      from public.commission_payments as payment
      where payment.commission_id = new.id
        and payment.payer_id = new.client_id
        and payment.payee_id = new.artist_id
        and payment.amount = new.amount
        and payment.currency = new.currency
        and payment.status = 'PAID'
        and payment.provider_verified_at is not null
    ) then
    raise exception 'PAYMENT_PROVIDER_VERIFICATION_REQUIRED';
  end if;

  return new;
end;
$$;

drop trigger if exists commissions_require_verified_payment_before_start
  on public.commissions;
create trigger commissions_require_verified_payment_before_start
before update of status on public.commissions
for each row
execute function public.require_verified_payment_before_commission_start();

commit;
