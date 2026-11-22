import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ids = {
  activeArtist: '10000000-0000-4000-8000-000000000001',
  activeClient: '20000000-0000-4000-8000-000000000001',
  secondArtist: '10000000-0000-4000-8000-000000000002',
  secondClient: '20000000-0000-4000-8000-000000000002',
  disabledArtist: '10000000-0000-4000-8000-000000000003',
  disabledClient: '20000000-0000-4000-8000-000000000003',
  reviewArtist: '10000000-0000-4000-8000-000000000004',
  reviewClient: '20000000-0000-4000-8000-000000000004',
  trustedRefundClient: '20000000-0000-4000-8000-000000000005',
  admin: '30000000-0000-4000-8000-000000000001',
};

const fixtureSql = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create function auth.role()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
grant usage on schema auth to authenticated, service_role;
grant execute on function auth.uid(), auth.role() to authenticated, service_role;

create schema storage;
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name text not null
);
alter table storage.objects enable row level security;

create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  username text not null unique,
  role text not null check (role in ('artist', 'client')),
  bio text,
  interests text[] not null default '{}',
  avatar_data_url text,
  onboarded boolean not null default false,
  is_pro boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
grant select, update on public.profiles to authenticated;
create policy "authenticated users can read profiles"
  on public.profiles for select to authenticated using (true);
create policy "users can update their own profile"
  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create table public.commissions (
  id uuid primary key default gen_random_uuid(),
  order_ref text unique,
  client_id uuid not null references public.profiles(id),
  artist_id uuid not null references public.profiles(id),
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.commissions enable row level security;
grant select on public.commissions to authenticated;
create policy "commission parties can read"
  on public.commissions for select to authenticated
  using (client_id = auth.uid() or artist_id = auth.uid());

create table public.conversations (id uuid primary key default gen_random_uuid());
create table public.conversation_participants (
  conversation_id uuid not null,
  user_id uuid not null,
  primary key (conversation_id, user_id)
);
create table public.messages (id uuid primary key default gen_random_uuid(), conversation_id uuid);
create table public.commission_milestones (
  id uuid primary key default gen_random_uuid(),
  commission_id uuid,
  status text not null default 'PENDING'
);
create table public.commission_deliverables (
  id uuid primary key default gen_random_uuid(),
  commission_id uuid,
  status text not null default 'PENDING'
);
create table public.revision_requests (
  id uuid primary key default gen_random_uuid(),
  commission_id uuid,
  status text not null default 'OPEN'
);
create table public.commission_progress_updates (
  id uuid primary key default gen_random_uuid(),
  commission_id uuid
);
create table public.artworks (id uuid primary key default gen_random_uuid());
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id),
  notification_type text not null,
  title text not null,
  message text not null,
  is_read boolean not null default false,
  related_id uuid,
  related_route text,
  created_at timestamptz not null default now()
);
create table public.artist_reviews (id uuid primary key default gen_random_uuid());
create table public.artwork_likes (id uuid primary key default gen_random_uuid());
create table public.artwork_comments (id uuid primary key default gen_random_uuid());
create table public.artwork_protection_settings (id uuid primary key default gen_random_uuid());
create table public.commission_post_comments (id uuid primary key default gen_random_uuid());
create table public.conversation_notification_preferences (id uuid primary key default gen_random_uuid());
create table public.user_blocks (id uuid primary key default gen_random_uuid());

alter table public.conversations enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.messages enable row level security;
alter table public.commission_milestones enable row level security;
alter table public.commission_deliverables enable row level security;
alter table public.revision_requests enable row level security;
alter table public.commission_progress_updates enable row level security;
alter table public.artworks enable row level security;
alter table public.notifications enable row level security;
alter table public.artist_reviews enable row level security;
alter table public.artwork_likes enable row level security;
alter table public.artwork_comments enable row level security;
alter table public.artwork_protection_settings enable row level security;
alter table public.commission_post_comments enable row level security;
alter table public.conversation_notification_preferences enable row level security;
alter table public.user_blocks enable row level security;

insert into auth.users (id, email) values
  ('${ids.activeArtist}', 'artist-one@example.test'),
  ('${ids.activeClient}', 'client-one@example.test'),
  ('${ids.secondArtist}', 'artist-two@example.test'),
  ('${ids.secondClient}', 'client-two@example.test'),
  ('${ids.disabledArtist}', 'artist-three@example.test'),
  ('${ids.disabledClient}', 'client-three@example.test'),
  ('${ids.reviewArtist}', 'artist-four@example.test'),
  ('${ids.reviewClient}', 'client-four@example.test'),
  ('${ids.trustedRefundClient}', 'client-five@example.test'),
  ('${ids.admin}', 'admin@example.test');

insert into public.profiles (id, name, username, role) values
  ('${ids.activeArtist}', 'Artist One', 'artist_one', 'artist'),
  ('${ids.activeClient}', 'Client One', 'client_one', 'client'),
  ('${ids.secondArtist}', 'Artist Two', 'artist_two', 'artist'),
  ('${ids.secondClient}', 'Client Two', 'client_two', 'client'),
  ('${ids.disabledArtist}', 'Artist Three', 'artist_three', 'artist'),
  ('${ids.disabledClient}', 'Client Three', 'client_three', 'client'),
  ('${ids.reviewArtist}', 'Artist Four', 'artist_four', 'artist'),
  ('${ids.reviewClient}', 'Client Four', 'client_four', 'client'),
  ('${ids.trustedRefundClient}', 'Client Five', 'client_five', 'client'),
  ('${ids.admin}', 'Admin', 'admin_user', 'client');
`;

const foundationalMigrations = [
  'commission-request-foundation.sql',
  'commission-request-review.sql',
  'artist-verification-foundation.sql',
  'profile-access-expand.sql',
  'artist-commission-services.sql',
  'commission-service-request.sql',
  'artist-commission-availability.sql',
  'commission-request-concurrency-hardening.sql',
  'commission-cancellation.sql',
  'commission-posts-foundation.sql',
  'commission-post-selection.sql',
  'commission-post-role-symmetry.sql',
  'commission-post-symmetric-selection.sql',
  'commission-payments-foundation.sql',
  'commission-payment-cancellation-coordination.sql',
  'commission-payment-refunds.sql',
  'commission-payment-simulation-lockdown.sql',
  'commission-demo-payments.sql',
  'commission-demo-payment-security-hardening.sql',
  'pro-entitlement-hardening.sql',
];

async function applyMigration(db, file) {
  const sql = await readFile(resolve(root, 'supabase', file), 'utf8');
  await db.exec(sql);
}

async function asUser(db, userId, query, params = []) {
  await db.exec(`
    set role authenticated;
    select set_config('request.jwt.claim.sub', '${userId}', false);
    select set_config('request.jwt.claim.role', 'authenticated', false);
  `);
  try {
    return await db.query(query, params);
  } finally {
    await db.exec(`
      reset role;
      select set_config('request.jwt.claim.sub', '', false);
      select set_config('request.jwt.claim.role', '', false);
    `);
  }
}

async function asReadOnlyUser(db, userId, query, params = []) {
  await db.exec(`
    set role authenticated;
    select set_config('request.jwt.claim.sub', '${userId}', false);
    select set_config('request.jwt.claim.role', 'authenticated', false);
    begin transaction read only;
  `);
  try {
    return await db.query(query, params);
  } finally {
    await db.exec(`
      rollback;
      reset role;
      select set_config('request.jwt.claim.sub', '', false);
      select set_config('request.jwt.claim.role', '', false);
    `);
  }
}

async function asServiceRole(db, query) {
  await db.exec(`
    set role service_role;
    select set_config('request.jwt.claim.sub', '', false);
    select set_config('request.jwt.claim.role', 'service_role', false);
  `);
  try {
    return await db.query(query);
  } finally {
    await db.exec(`
      reset role;
      select set_config('request.jwt.claim.sub', '', false);
      select set_config('request.jwt.claim.role', '', false);
    `);
  }
}

async function setDemoPaymentsEnabled(db, enabled) {
  await db.query(
    `update public.commission_demo_payment_config
     set enabled = $1, updated_at = now()
     where singleton = true`,
    [enabled],
  );
}

async function expectRejected(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.match(error.message, pattern);
    return true;
  });
}

test('account lifecycle and commission integrations use complete PGlite dependencies', async () => {
  const db = new PGlite();
  try {
    await db.exec(fixtureSql);

    for (const migration of foundationalMigrations) {
      await applyMigration(db, migration);
    }

    const demoConfig = await db.query(`
      select enabled from public.commission_demo_payment_config where singleton = true
    `);
    assert.equal(demoConfig.rows[0].enabled, false);
    await expectRejected(
      asUser(
        db,
        ids.activeClient,
        `update public.commission_demo_payment_config
         set enabled = true where singleton = true`,
      ),
      /permission denied|42501/i,
    );
    await expectRejected(
      asServiceRole(
        db,
        `update public.commission_demo_payment_config
         set enabled = true where singleton = true`,
      ),
      /permission denied|42501/i,
    );
    const paymentRpcGrants = await db.query(`
      select
        has_function_privilege('authenticated', 'public.simulate_commission_payment_demo_success(uuid)', 'EXECUTE') as client_can_demo_pay,
        has_function_privilege('authenticated', 'public.simulate_commission_payment_failure(uuid)', 'EXECUTE') as client_can_simulate_failure,
        has_function_privilege('anon', 'public.simulate_commission_payment_failure(uuid)', 'EXECUTE') as anon_can_simulate_failure,
        has_function_privilege('authenticated', 'public.simulate_commission_payment_refund(uuid)', 'EXECUTE') as client_can_simulate_refund,
        has_function_privilege('anon', 'public.simulate_commission_payment_refund(uuid)', 'EXECUTE') as anon_can_simulate_refund,
        has_function_privilege('authenticated', 'public.simulate_commission_payment_success(uuid)', 'EXECUTE') as client_can_provider_pay,
        has_function_privilege('service_role', 'public.simulate_commission_payment_success(uuid)', 'EXECUTE') as service_can_provider_pay
    `);
    assert.equal(paymentRpcGrants.rows[0].client_can_demo_pay, true);
    assert.equal(paymentRpcGrants.rows[0].client_can_simulate_failure, true);
    assert.equal(paymentRpcGrants.rows[0].anon_can_simulate_failure, false);
    assert.equal(paymentRpcGrants.rows[0].client_can_simulate_refund, true);
    assert.equal(paymentRpcGrants.rows[0].anon_can_simulate_refund, false);
    assert.equal(paymentRpcGrants.rows[0].client_can_provider_pay, false);
    assert.equal(paymentRpcGrants.rows[0].service_can_provider_pay, true);

    await db.exec(`
      update public.profiles
      set is_admin = true
      where id = '${ids.admin}';

      insert into public.commissions (
        order_ref, client_id, artist_id, title, description, status, requested_at
      )
      values (
        'existing-active-commission',
        '${ids.secondClient}',
        '${ids.secondArtist}',
        'Existing work',
        'Must remain unchanged',
        'IN_PROGRESS',
        now()
      );
    `);

    await applyMigration(db, 'account-lifecycle-hardening.sql');
    const publicArtistProfile = await asReadOnlyUser(
      db,
      ids.activeClient,
      `select
        id, name, username, role, bio, interests, avatar_data_url, is_pro,
        accepting_commissions, onboarded, last_seen_at, artist_verification_status
      from public.profiles
      where id = $1`,
      [ids.activeArtist],
    );
    assert.equal(publicArtistProfile.rows.length, 1);
    assert.equal(publicArtistProfile.rows[0].role, 'artist');

    await applyMigration(db, 'account-lifecycle-active-check-readonly.sql');
    await applyMigration(db, 'account-lifecycle-commission-integration.sql');
    await applyMigration(db, 'account-deletion-admin-review.sql');
    await db.exec(`
      grant usage on schema public to service_role;
      grant select on public.commissions, public.commission_payments to service_role;
      grant update (status, refunded_amount, refunded_at)
        on public.commission_payments to service_role;
    `);

    const profileBackfill = await db.query(`
      select
        count(*) filter (where lifecycle.user_id is null) as missing_rows,
        count(*) filter (
          where lifecycle.status = 'ACTIVE'
            and profile.name in ('Artist One', 'Client One')
        ) as preserved_profiles
      from public.profiles as profile
      left join public.account_lifecycle as lifecycle on lifecycle.user_id = profile.id
    `);
    assert.equal(profileBackfill.rows[0].missing_rows, 0);
    assert.equal(profileBackfill.rows[0].preserved_profiles, 2);

    const existingCommission = await db.query(`
      select status, title
      from public.commissions
      where order_ref = 'existing-active-commission'
    `);
    assert.deepEqual(existingCommission.rows[0], {
      status: 'IN_PROGRESS',
      title: 'Existing work',
    });

    const activeService = await asUser(
      db,
      ids.activeArtist,
      `select * from public.create_artist_commission_service('Active service', 'Normal listing', 100, 'USD', 5)`,
    );
    assert.equal(activeService.rows[0].name, 'Active service');

    const activeServiceUpdate = await asUser(
      db,
      ids.activeArtist,
      `select * from public.update_artist_commission_service(
        '${activeService.rows[0].service_id}', 'Active service revised', 'Owner update', 110, 'USD', 6
      )`,
    );
    assert.equal(activeServiceUpdate.rows[0].name, 'Active service revised');
    await expectRejected(
      asUser(
        db,
        ids.activeClient,
        `select public.update_artist_commission_service(
          '${activeService.rows[0].service_id}', 'Unauthorized edit', null, 110, 'USD', 6
        )`,
      ),
      /Only artists|not owned/i,
    );

    const demoService = await asUser(
      db,
      ids.activeArtist,
      `select * from public.create_artist_commission_service(
        'Demo service', 'Simulation test', 750, 'PHP', 5
      )`,
    );
    const demoRequest = await asUser(
      db,
      ids.activeClient,
      `select public.create_service_commission_request(
        '${demoService.rows[0].service_id}', 'Demo commission', 'Payment flow test'
      ) as result`,
    );
    const demoCommissionId = demoRequest.rows[0].result.commission_id;
    await expectRejected(
      asUser(db, ids.activeClient, `select public.create_commission_payment('${demoCommissionId}')`),
      /Only accepted commissions/i,
    );
    await asUser(db, ids.activeArtist, `select public.accept_commission_request('${demoCommissionId}')`);

    const firstDemoPayment = await asUser(
      db,
      ids.activeClient,
      `select * from public.create_commission_payment('${demoCommissionId}')`,
    );
    assert.equal(Number(firstDemoPayment.rows[0].amount), 750);
    const duplicatePendingPayment = await asUser(
      db,
      ids.activeClient,
      `select * from public.create_commission_payment('${demoCommissionId}')`,
    );
    assert.equal(duplicatePendingPayment.rows[0].id, firstDemoPayment.rows[0].id);

    await expectRejected(
      asUser(
        db,
        ids.activeClient,
        `select public.simulate_commission_payment_demo_success('${firstDemoPayment.rows[0].id}')`,
      ),
      /DEMO_PAYMENTS_DISABLED/i,
    );
    await expectRejected(
      asUser(
        db,
        ids.activeClient,
        `select public.simulate_commission_payment_failure('${firstDemoPayment.rows[0].id}')`,
      ),
      /DEMO_PAYMENTS_DISABLED/i,
    );

    await setDemoPaymentsEnabled(db, true);
    await expectRejected(
      asUser(
        db,
        ids.secondClient,
        `select public.simulate_commission_payment_failure('${firstDemoPayment.rows[0].id}')`,
      ),
      /Payment not found/i,
    );
    await asUser(
      db,
      ids.activeClient,
      `select public.simulate_commission_payment_failure('${firstDemoPayment.rows[0].id}')`,
    );
    assert.equal((await asUser(
      db,
      ids.activeArtist,
      'select * from public.list_my_demo_commission_earnings()',
    )).rows.length, 0);
    const retriedDemoPayment = await asUser(
      db,
      ids.activeClient,
      `select * from public.create_commission_payment('${demoCommissionId}')`,
    );
    assert.notEqual(retriedDemoPayment.rows[0].id, firstDemoPayment.rows[0].id);
    await expectRejected(
      asUser(
        db,
        ids.activeArtist,
        `select public.simulate_commission_payment_demo_success('${retriedDemoPayment.rows[0].id}')`,
      ),
      /Only client accounts/i,
    );
    await expectRejected(
      asUser(
        db,
        ids.secondClient,
        `select public.simulate_commission_payment_demo_success('${retriedDemoPayment.rows[0].id}')`,
      ),
      /Payment not found/i,
    );

    const simulatedPayment = await asUser(
      db,
      ids.activeClient,
      `select * from public.simulate_commission_payment_demo_success('${retriedDemoPayment.rows[0].id}')`,
    );
    assert.equal(simulatedPayment.rows[0].status, 'PAID');
    assert.equal(simulatedPayment.rows[0].provider, 'DEMO_SIMULATION');
    assert.ok(simulatedPayment.rows[0].demo_paid_at);
    assert.equal(simulatedPayment.rows[0].provider_verified_at, null);

    const duplicateSuccess = await asUser(
      db,
      ids.activeClient,
      `select * from public.simulate_commission_payment_demo_success('${retriedDemoPayment.rows[0].id}')`,
    );
    assert.equal(duplicateSuccess.rows[0].id, simulatedPayment.rows[0].id);
    const activeArtistEarnings = await asUser(
      db,
      ids.activeArtist,
      'select * from public.list_my_demo_commission_earnings()',
    );
    assert.equal(activeArtistEarnings.rows.length, 1);
    assert.equal(activeArtistEarnings.rows[0].earnings_category, 'PENDING');
    assert.equal(activeArtistEarnings.rows[0].client_name, 'Client One');
    assert.equal(activeArtistEarnings.rows[0].commission_title, 'Demo commission');
    assert.equal(Number(activeArtistEarnings.rows[0].amount), 750);
    assert.equal((await asUser(
      db,
      ids.activeClient,
      'select * from public.list_my_demo_commission_earnings()',
    )).rows.length, 0);
    assert.equal((await asUser(
      db,
      ids.secondArtist,
      'select * from public.list_my_demo_commission_earnings()',
    )).rows.length, 0);

    await setDemoPaymentsEnabled(db, false);
    await expectRejected(
      db.query(`update public.commissions set status = 'IN_PROGRESS' where id = '${demoCommissionId}'`),
      /PAYMENT_PROVIDER_VERIFICATION_REQUIRED/i,
    );
    await setDemoPaymentsEnabled(db, true);
    await db.query(`update public.commissions set status = 'IN_PROGRESS' where id = '${demoCommissionId}'`);
    await db.query(`update public.commissions set status = 'COMPLETED' where id = '${demoCommissionId}'`);
    const completedArtistEarnings = await asUser(
      db,
      ids.activeArtist,
      'select * from public.list_my_demo_commission_earnings()',
    );
    assert.equal(completedArtistEarnings.rows[0].earnings_category, 'COMPLETED');

    const secondArtistService = await asUser(
      db,
      ids.secondArtist,
      `select * from public.create_artist_commission_service(
        'Refund demo service', 'Cancellation test', 500, 'PHP', 4
      )`,
    );
    const refundRequest = await asUser(
      db,
      ids.secondClient,
      `select public.create_service_commission_request(
        '${secondArtistService.rows[0].service_id}', 'Refund demo commission', 'Refund test'
      ) as result`,
    );
    const refundCommissionId = refundRequest.rows[0].result.commission_id;
    await asUser(db, ids.secondArtist, `select public.accept_commission_request('${refundCommissionId}')`);
    const refundPayment = await asUser(
      db,
      ids.secondClient,
      `select * from public.create_commission_payment('${refundCommissionId}')`,
    );
    await asUser(
      db,
      ids.secondClient,
      `select public.simulate_commission_payment_demo_success('${refundPayment.rows[0].id}')`,
    );
    await asUser(
      db,
      ids.secondClient,
      `select public.cancel_commission('${refundCommissionId}', 'Demo cancellation')`,
    );
    const cancelledEarnings = await asUser(
      db,
      ids.secondArtist,
      'select * from public.list_my_demo_commission_earnings()',
    );
    assert.equal(cancelledEarnings.rows[0].earnings_category, 'CANCELLED');

    await setDemoPaymentsEnabled(db, false);
    await expectRejected(
      asUser(
        db,
        ids.secondClient,
        `select public.simulate_commission_payment_refund('${refundPayment.rows[0].id}')`,
      ),
      /DEMO_PAYMENTS_DISABLED/i,
    );
    await setDemoPaymentsEnabled(db, true);
    await expectRejected(
      asUser(
        db,
        ids.activeClient,
        `select public.simulate_commission_payment_refund('${refundPayment.rows[0].id}')`,
      ),
      /Payment not found/i,
    );

    await db.query(`
      update public.commission_payments
      set provider = 'XENDIT',
          provider_reference = 'provider-refund-unverified',
          demo_paid_at = null
      where id = '${refundPayment.rows[0].id}'
    `);
    await expectRejected(
      asUser(
        db,
        ids.secondClient,
        `select public.simulate_commission_payment_refund('${refundPayment.rows[0].id}')`,
      ),
      /explicitly marked demo payments/i,
    );
    const unverifiedRefundState = await db.query(`select status, refunded_at
      from public.commission_payments where id = '${refundPayment.rows[0].id}'`);
    assert.equal(unverifiedRefundState.rows[0].status, 'PAID');
    assert.equal(unverifiedRefundState.rows[0].refunded_at, null);

    await db.query(`
      update public.commission_payments
      set provider_verified_at = now()
      where id = '${refundPayment.rows[0].id}'
    `);
    await expectRejected(
      asUser(
        db,
        ids.secondClient,
        `select public.simulate_commission_payment_refund('${refundPayment.rows[0].id}')`,
      ),
      /Provider-verified payments/i,
    );
    assert.equal((await db.query(
      `select status from public.commission_payments where id = '${refundPayment.rows[0].id}'`,
    )).rows[0].status, 'PAID');
    await db.query(`
      update public.commission_payments
      set provider = 'DEMO_SIMULATION',
          provider_reference = null,
          provider_verified_at = null,
          demo_paid_at = now()
      where id = '${refundPayment.rows[0].id}'
    `);

    const simulatedDemoRefund = await asUser(
      db,
      ids.secondClient,
      `select * from public.simulate_commission_payment_refund('${refundPayment.rows[0].id}')`,
    );
    assert.equal(simulatedDemoRefund.rows[0].status, 'REFUNDED');
    assert.equal(Number(simulatedDemoRefund.rows[0].refunded_amount), 500);
    const duplicateRefund = await asUser(
      db,
      ids.secondClient,
      `select * from public.simulate_commission_payment_refund('${refundPayment.rows[0].id}')`,
    );
    assert.equal(duplicateRefund.rows[0].status, 'REFUNDED');
    assert.equal(Number(duplicateRefund.rows[0].refunded_amount), 500);
    const refundedEarnings = await asUser(
      db,
      ids.secondArtist,
      'select * from public.list_my_demo_commission_earnings()',
    );
    assert.equal(refundedEarnings.rows[0].earnings_category, 'REFUNDED');
    const isolatedArtistEarnings = await asUser(
      db,
      ids.activeArtist,
      'select * from public.list_my_demo_commission_earnings()',
    );
    assert.equal(isolatedArtistEarnings.rows.length, 1);
    assert.equal(isolatedArtistEarnings.rows[0].commission_id, demoCommissionId);

    const unverifiedService = await asUser(
      db,
      ids.secondArtist,
      `select * from public.create_artist_commission_service(
        'Unverified payment service', 'Start-gate test', 300, 'PHP', 3
      )`,
    );
    const unverifiedRequest = await asUser(
      db,
      ids.secondClient,
      `select public.create_service_commission_request(
        '${unverifiedService.rows[0].service_id}', 'Unverified payment commission', 'Start gate'
      ) as result`,
    );
    const unverifiedCommissionId = unverifiedRequest.rows[0].result.commission_id;
    await asUser(db, ids.secondArtist, `select public.accept_commission_request('${unverifiedCommissionId}')`);
    const unverifiedPayment = await asUser(
      db,
      ids.secondClient,
      `select * from public.create_commission_payment('${unverifiedCommissionId}')`,
    );
    await db.query(`
      update public.commission_payments
      set provider = 'XENDIT', provider_reference = 'test-provider-pending'
      where id = '${unverifiedPayment.rows[0].id}'
    `);
    await expectRejected(
      asUser(
        db,
        ids.secondClient,
        `select public.simulate_commission_payment_failure('${unverifiedPayment.rows[0].id}')`,
      ),
      /unassociated mock payments/i,
    );
    assert.equal((await db.query(
      `select status from public.commission_payments where id = '${unverifiedPayment.rows[0].id}'`,
    )).rows[0].status, 'PENDING');
    await db.query(`
      update public.commission_payments
      set status = 'PAID', paid_at = now(), provider_verified_at = now()
      where id = '${unverifiedPayment.rows[0].id}'
    `);
    await expectRejected(
      asUser(
        db,
        ids.secondClient,
        `select public.simulate_commission_payment_failure('${unverifiedPayment.rows[0].id}')`,
      ),
      /Provider-verified payments/i,
    );
    assert.equal((await db.query(
      `select status from public.commission_payments where id = '${unverifiedPayment.rows[0].id}'`,
    )).rows[0].status, 'PAID');
    await db.query(`
      update public.commission_payments
      set provider_verified_at = null
      where id = '${unverifiedPayment.rows[0].id}'
    `);
    await expectRejected(
      db.exec(`update public.commissions set status = 'IN_PROGRESS' where id = '${unverifiedCommissionId}'`),
      /PAYMENT_PROVIDER_VERIFICATION_REQUIRED/i,
    );
    await setDemoPaymentsEnabled(db, false);
    await db.query(`
      update public.commission_payments
      set provider_verified_at = now()
      where id = '${unverifiedPayment.rows[0].id}'
    `);
    await db.query(`update public.commissions set status = 'IN_PROGRESS' where id = '${unverifiedCommissionId}'`);

    const activeDiscovery = await asUser(
      db,
      ids.activeClient,
      `select * from public.list_active_artist_commission_services('${ids.activeArtist}')`,
    );
    assert.equal(activeDiscovery.rows.length, 2);

    const activeRequest = await asUser(
      db,
      ids.activeClient,
      `select public.create_service_commission_request(
        '${activeService.rows[0].service_id}',
        'Active request',
        'Normal active-user request'
      ) as result`,
    );
    assert.equal(activeRequest.rows[0].result.created, true);

    const disabledService = await asUser(
      db,
      ids.disabledArtist,
      `select * from public.create_artist_commission_service('Keep this listing', null, 50, 'USD', 3)`,
    );
    const disabledServiceId = disabledService.rows[0].service_id;
    await asUser(db, ids.disabledArtist, 'select public.deactivate_my_account()');

    const retainedService = await db.query(`
      select count(*) as count, bool_or(is_active) as is_active
      from public.artist_commission_services
      where artist_id = '${ids.disabledArtist}'
    `);
    assert.equal(retainedService.rows[0].count, 1);
    assert.equal(retainedService.rows[0].is_active, false);

    await expectRejected(
      asUser(
        db,
        ids.disabledArtist,
        `select public.update_artist_commission_service(
          '${disabledServiceId}', 'Edited while inactive', null, 50, 'USD', 3
        )`,
      ),
      /deactivated|not provisioned|42501/i,
    );
    await expectRejected(
      asUser(
        db,
        ids.disabledArtist,
        `select * from public.create_artist_commission_service('New inactive listing', null, 50, 'USD', 3)`,
      ),
      /deactivated|not provisioned|42501/i,
    );
    await expectRejected(
      asUser(
        db,
        ids.disabledArtist,
        `select public.set_artist_commission_service_active('${disabledServiceId}', true)`,
      ),
      /deactivated|not provisioned|42501/i,
    );

    const discoverableDisabledServices = await asUser(
      db,
      ids.activeClient,
      `select * from public.list_active_artist_commission_services('${ids.disabledArtist}')`,
    );
    assert.equal(discoverableDisabledServices.rows.length, 0);

    await expectRejected(
      asUser(
        db,
        ids.activeClient,
        `select public.create_commission_request(
          '${ids.disabledArtist}', 'Must not create', 'Inactive artist'
        )`,
      ),
      /writable accounts|42501/i,
    );

    await asUser(db, ids.disabledClient, 'select public.deactivate_my_account()');
    await expectRejected(
      asUser(
        db,
        ids.disabledClient,
        `select public.create_commission_request(
          '${ids.secondArtist}', 'Must not create', 'Inactive client'
        )`,
      ),
      /deactivated|not provisioned|42501/i,
    );

    const clientOwnedPost = await asUser(
      db,
      ids.activeClient,
      `select (public.create_commission_post('Client post', 'Description', 10, 100, 'USD')).id as id`,
    );
    const clientPostId = clientOwnedPost.rows[0].id;
    const artistApplication = await asUser(
      db,
      ids.activeArtist,
      `select (public.create_commission_post_application('${clientPostId}', 'Artist application')).id as id`,
    );
    const clientOwnedSelection = await asUser(
      db,
      ids.activeClient,
      `select public.select_commission_post_applicant('${clientPostId}', '${artistApplication.rows[0].id}', 50, 'USD') as result`,
    );
    assert.ok(clientOwnedSelection.rows[0].result);

    const artistOwnedPost = await asUser(
      db,
      ids.secondArtist,
      `select (public.create_commission_post('Artist post', 'Description', 10, 100, 'USD')).id as id`,
    );
    const clientApplication = await asUser(
      db,
      ids.secondClient,
      `select (public.create_commission_post_application('${artistOwnedPost.rows[0].id}', 'Client application')).id as id`,
    );
    const artistOwnedSelection = await asUser(
      db,
      ids.secondArtist,
      `select public.select_commission_post_applicant(
        '${artistOwnedPost.rows[0].id}', '${clientApplication.rows[0].id}', 50, 'USD'
      ) as result`,
    );
    assert.ok(artistOwnedSelection.rows[0].result);

    const inactiveApplicantPost = await asUser(
      db,
      ids.reviewClient,
      `select (public.create_commission_post('Inactive artist applicant', 'Description', 10, 100, 'USD')).id as id`,
    );
    const staleArtistApplication = await db.query(`
      insert into public.commission_post_applications (
        commission_post_id, artist_id, applicant_id, applicant_role, message, status
      )
      values (
        '${inactiveApplicantPost.rows[0].id}',
        '${ids.disabledArtist}',
        '${ids.disabledArtist}',
        'artist',
        'Stale application from an inactive account',
        'PENDING'
      )
      returning id
    `);
    await expectRejected(
      asUser(
        db,
        ids.reviewClient,
        `select public.select_commission_post_applicant(
          '${inactiveApplicantPost.rows[0].id}', '${staleArtistApplication.rows[0].id}', 50, 'USD'
        )`,
      ),
      /writable accounts|42501/i,
    );

    const inactiveApplicantClientPost = await asUser(
      db,
      ids.secondArtist,
      `select (public.create_commission_post('Inactive client applicant', 'Description', 10, 100, 'USD')).id as id`,
    );
    const staleClientApplication = await db.query(`
      insert into public.commission_post_applications (
        commission_post_id, artist_id, applicant_id, applicant_role, message, status
      )
      values (
        '${inactiveApplicantClientPost.rows[0].id}',
        '${ids.disabledClient}',
        '${ids.disabledClient}',
        'client',
        'Stale application from an inactive account',
        'PENDING'
      )
      returning id
    `);
    await expectRejected(
      asUser(
        db,
        ids.secondArtist,
        `select public.select_commission_post_applicant(
          '${inactiveApplicantClientPost.rows[0].id}', '${staleClientApplication.rows[0].id}', 50, 'USD'
        )`,
      ),
      /writable accounts|42501/i,
    );

    await db.exec(`
      update public.commission_posts
      set status = 'CLOSED'
      where owner_id = '${ids.reviewClient}';
    `);

    await db.exec(`
      insert into public.commissions (
        order_ref, client_id, artist_id, title, description, status, requested_at,
        amount, currency, cancelled_at
      )
      values (
        'pending-refund-commission',
        '${ids.reviewClient}',
        '${ids.reviewArtist}',
        'Cancelled paid commission',
        'Refund must finish before deactivation',
        'CANCELLED',
        now(),
        25,
        'USD',
        now()
      );
      insert into public.commission_payments (
        commission_id, payer_id, payee_id, amount, currency, status, created_by
      )
      select id, '${ids.reviewClient}', '${ids.reviewArtist}', 25, 'USD', 'PENDING', '${ids.reviewClient}'
      from public.commissions
      where order_ref = 'pending-refund-commission';
    `);
    await expectRejected(
      asUser(db, ids.reviewClient, 'select public.deactivate_my_account()'),
      /pending payment/i,
    );
    await db.query(`
      update public.commission_payments
      set status = 'FAILED'
      where commission_id = (
        select id from public.commissions where order_ref = 'pending-refund-commission'
      )
    `);
    await db.query(`
      insert into public.commission_payments (
        commission_id, payer_id, payee_id, amount, currency, status,
        provider, demo_paid_at, created_by, paid_at
      )
      select id, '${ids.reviewClient}', '${ids.reviewArtist}', 25, 'USD', 'PAID',
             'DEMO_SIMULATION', now(), '${ids.reviewClient}', now()
      from public.commissions
      where order_ref = 'pending-refund-commission'
    `);
    await expectRejected(
      asUser(db, ids.reviewClient, 'select public.deactivate_my_account()'),
      /refund/i,
    );

    await setDemoPaymentsEnabled(db, true);
    const simulatedRefund = await asUser(
      db,
      ids.reviewClient,
      `select status from public.simulate_commission_payment_refund(
        (select id from public.commission_payments
         where commission_id = (select id from public.commissions where order_ref = 'pending-refund-commission')
           and status = 'PAID')
      )`,
    );
    assert.equal(simulatedRefund.rows[0].status, 'REFUNDED');
    await asUser(db, ids.reviewClient, 'select public.deactivate_my_account()');

    // Test only the trusted write-guard boundary for an out-of-band state change.
    await db.exec(`
      insert into public.commissions (
        order_ref, client_id, artist_id, title, description, status, requested_at,
        amount, currency, cancelled_at
      )
      values (
        'trusted-refund-commission',
        '${ids.trustedRefundClient}',
        '${ids.activeArtist}',
        'Trusted refund',
        'Service-role completion boundary',
        'CANCELLED',
        now(),
        15,
        'USD',
        now()
      );
      insert into public.commission_payments (
        commission_id, payer_id, payee_id, amount, currency, status, created_by, paid_at
      )
      select id, '${ids.trustedRefundClient}', '${ids.activeArtist}', 15, 'USD',
             'PAID', '${ids.trustedRefundClient}', now()
      from public.commissions
      where order_ref = 'trusted-refund-commission';
      update public.account_lifecycle
      set status = 'DEACTIVATED', deactivated_at = now()
      where user_id = '${ids.trustedRefundClient}';
    `);
    const trustedRefund = await asServiceRole(
      db,
      `update public.commission_payments
       set status = 'REFUNDED', refunded_amount = amount, refunded_at = now()
       where commission_id = (
         select id from public.commissions where order_ref = 'trusted-refund-commission'
       )
       returning status`,
    );
    assert.equal(trustedRefund.rows[0].status, 'REFUNDED');

    await expectRejected(
      asUser(
        db,
        ids.activeClient,
        `update public.commission_payments set status = 'REFUNDED'
         where commission_id = (select id from public.commissions where order_ref = 'existing-active-commission')`,
      ),
      /permission denied/i,
    );

    const deletionRequest = await asUser(
      db,
      ids.reviewArtist,
      'select public.request_my_account_deletion() as result',
    );
    const requestId = deletionRequest.rows[0].result.id;
    await asUser(
      db,
      ids.admin,
      `select public.review_account_deletion_request('${requestId}', 'IN_REVIEW', null)`,
    );
    const inReviewWritable = await asUser(
      db,
      ids.reviewArtist,
      `select public.is_my_account_writable() as writable`,
    );
    assert.equal(inReviewWritable.rows[0].writable, false);

    await expectRejected(
      asUser(
        db,
        ids.activeClient,
        `select public.create_commission_request(
          '${ids.reviewArtist}', 'Must not create', 'Artist has an IN_REVIEW deletion request'
        )`,
      ),
      /writable accounts|42501/i,
    );

    await expectRejected(
      asUser(
        db,
        ids.reviewArtist,
        `update public.profiles set name = 'Should be blocked'
         where id = '${ids.reviewArtist}'`,
      ),
      /deactivated|deletion request|42501/i,
    );

    await expectRejected(
      asUser(
        db,
        ids.reviewArtist,
        `update public.account_lifecycle
         set status = 'DEACTIVATED', deactivated_at = now()
         where user_id = '${ids.reviewArtist}'`,
      ),
      /permission denied/i,
    );

    await applyMigration(db, 'account-lifecycle-hardening.sql');
    const preservedReview = await db.query(`
      select status from public.account_deletion_requests where id = '${requestId}'
    `);
    assert.equal(preservedReview.rows[0].status, 'IN_REVIEW');
    const stillNotWritable = await db.query(`
      select public.is_my_account_writable() as writable
    `);
    assert.equal(stillNotWritable.rows[0].writable, false);

    await expectRejected(
      asUser(
        db,
        ids.activeClient,
        `update public.profiles set is_pro = true where id = '${ids.activeClient}'`,
      ),
      /permission denied/i,
    );
    await asUser(
      db,
      ids.activeClient,
      `update public.profiles set name = 'Client One Edited' where id = '${ids.activeClient}'`,
    );

    const finalState = await db.query(`
      select
        (select status from public.commissions where order_ref = 'existing-active-commission') as existing_commission,
        (select status from public.commission_payments
         where commission_id = (select id from public.commissions where order_ref = 'pending-refund-commission')
           and status = 'REFUNDED') as refund_status,
        (select status from public.account_deletion_requests where id = '${requestId}') as request_status
    `);
    assert.deepEqual(finalState.rows[0], {
      existing_commission: 'IN_PROGRESS',
      refund_status: 'REFUNDED',
      request_status: 'IN_REVIEW',
    });

    const setupGuide = await readFile(resolve(root, 'SUPABASE-SETUP.md'), 'utf8');
    const diagnosticsSection = setupGuide.match(
      /The read-only relation\/RLS preflight[\s\S]*?(?=These catalog checks confirm)/,
    )?.[0];
    assert.ok(diagnosticsSection);
    const diagnosticQueries = [
      ...diagnosticsSection.matchAll(/```sql\s*([\s\S]*?)```/g),
    ];
    assert.equal(diagnosticQueries.length, 2);
    for (const [, query] of diagnosticQueries) {
      await db.exec(query);
    }
  } finally {
    await db.close();
  }
});
