import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const foundationMigration = await readFile(
  resolve(root, 'supabase/commission-final-delivery-foundation.sql'),
  'utf8',
);

const testIds = {
  artist: '10000000-0000-4000-8000-000000000001',
  artistTwo: '10000000-0000-4000-8000-000000000002',
  client: '20000000-0000-4000-8000-000000000001',
  clientTwo: '20000000-0000-4000-8000-000000000002',
};

const fixture = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
grant usage on schema auth to authenticated, service_role;
grant execute on function auth.uid(), auth.role() to authenticated, service_role;

create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name text not null
);
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated, service_role;
grant select, insert on storage.objects to authenticated, service_role;

create table public.profiles (
  id uuid primary key references auth.users(id),
  role text not null,
  name text not null
);
create table public.commissions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references auth.users(id),
  artist_id uuid not null references auth.users(id),
  status text not null default 'IN_PROGRESS',
  title text not null default 'Commission',
  completed_at timestamptz,
  completed_by uuid references auth.users(id),
  final_delivery_required boolean not null default false
);
create table public.commission_milestones (
  id uuid primary key default gen_random_uuid(),
  commission_id uuid not null references public.commissions(id),
  name text not null,
  status text not null
);
create table public.commission_deliverables (
  id uuid primary key default gen_random_uuid(),
  commission_id uuid not null references public.commissions(id),
  status text not null
);
create table public.revision_requests (
  id uuid primary key default gen_random_uuid(),
  commission_id uuid not null references public.commissions(id),
  status text not null
);
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id),
  notification_type text not null,
  title text not null,
  message text not null,
  related_id uuid,
  related_route text
);

insert into auth.users (id) values
  ('${testIds.artist}'), ('${testIds.artistTwo}'),
  ('${testIds.client}'), ('${testIds.clientTwo}');
insert into public.profiles (id, role, name) values
  ('${testIds.artist}', 'artist', 'Artist One'),
  ('${testIds.artistTwo}', 'artist', 'Artist Two'),
  ('${testIds.client}', 'client', 'Client One'),
  ('${testIds.clientTwo}', 'client', 'Client Two');
`;

const database = new PGlite();
await database.exec(fixture);
await database.exec(foundationMigration);

async function setIdentity(role, userId) {
  await database.exec(`set role ${role}`);
  await database.query(
    `select set_config('request.jwt.claim.sub', $1, false),
            set_config('request.jwt.claim.role', $2, false)`,
    [userId, role],
  );
}

async function resetIdentity() {
  await database.exec('reset role');
  await database.query(
    `select set_config('request.jwt.claim.sub', '', false),
            set_config('request.jwt.claim.role', '', false)`,
  );
}

async function withReservationWindow(deliveryId, remaining, role, callback) {
  await database.exec('begin');
  try {
    await database.query(
      `update public.commission_final_deliveries
       set expires_at = now() + $2::interval
       where id = $1`,
      [deliveryId, remaining],
    );
    await setIdentity(role, testIds.artist);
    return await callback();
  } finally {
    await database.exec('rollback');
    await resetIdentity();
  }
}

async function createCommission({
  artistId = testIds.artist,
  clientId = testIds.client,
  finalDeliveryRequired = true,
  status = 'IN_PROGRESS',
  milestones = [{ name: 'Final Render', status: 'APPROVED' }],
  deliverables = [],
  revisions = [],
} = {}) {
  const { rows } = await database.query(
    `insert into public.commissions (artist_id, client_id, final_delivery_required, status)
     values ($1, $2, $3, $4) returning id`,
    [artistId, clientId, finalDeliveryRequired, status],
  );
  const commissionId = rows[0].id;
  for (const milestone of milestones) {
    await database.query(
      'insert into public.commission_milestones (commission_id, name, status) values ($1, $2, $3)',
      [commissionId, milestone.name, milestone.status],
    );
  }
  for (const deliverableStatus of deliverables) {
    await database.query(
      'insert into public.commission_deliverables (commission_id, status) values ($1, $2)',
      [commissionId, deliverableStatus],
    );
  }
  for (const revisionStatus of revisions) {
    await database.query(
      'insert into public.revision_requests (commission_id, status) values ($1, $2)',
      [commissionId, revisionStatus],
    );
  }
  return commissionId;
}

async function beginBatch(commissionId, files = [{ filename: 'final.jpg', mime_type: 'image/jpeg', size_bytes: 4 }]) {
  await setIdentity('authenticated', testIds.artist);
  try {
    const { rows } = await database.query(
      'select public.begin_commission_final_delivery($1, $2::jsonb) as result',
      [commissionId, JSON.stringify(files)],
    );
    return rows[0].result;
  } finally {
    await resetIdentity();
  }
}

async function reserveObject(deliveryId, fileId, actorId = testIds.artist) {
  const { rows } = await database.query(
    'select storage_path from public.commission_final_delivery_files where id = $1 and delivery_id = $2',
    [fileId, deliveryId],
  );
  const path = rows[0].storage_path;
  await setIdentity('authenticated', actorId);
  try {
    await database.query(
      'insert into storage.objects (bucket_id, name) values ($1, $2)',
      ['commission-final-deliveries', path],
    );
  } finally {
    await resetIdentity();
  }
  return path;
}

async function finalizeBatch(deliveryId, fileId, actorId = testIds.artist) {
  return finalizeManifest(deliveryId, [{
    file_id: fileId,
    mime_type: 'image/jpeg',
    size_bytes: 4,
    sha256: 'a'.repeat(64),
  }], actorId);
}

async function finalizeManifest(deliveryId, files, actorId = testIds.artist) {
  await setIdentity('service_role', actorId);
  try {
    const { rows } = await database.query(
      `select public.finalize_commission_final_delivery(
        $1, $2, $3::jsonb
      ) as result`,
      [deliveryId, actorId, JSON.stringify(files)],
    );
    return rows[0].result;
  } finally {
    await resetIdentity();
  }
}

async function acceptBatch(deliveryId, actorId = testIds.client) {
  await setIdentity('authenticated', actorId);
  try {
    const { rows } = await database.query(
      'select public.accept_commission_final_delivery($1) as result',
      [deliveryId],
    );
    return rows[0].result;
  } finally {
    await resetIdentity();
  }
}

test('Final Render approval, participant role checks, and protected Storage reads are enforced', async () => {
  const blockedCommission = await createCommission({
    milestones: [{ name: 'Final Render', status: 'IN_PROGRESS' }],
  });
  await assert.rejects(beginBatch(blockedCommission), /Final Render must be approved/i);

  const commissionId = await createCommission();
  await setIdentity('authenticated', testIds.client);
  try {
    await assert.rejects(
      database.query('select public.begin_commission_final_delivery($1, $2::jsonb)', [
        commissionId,
        JSON.stringify([{ filename: 'final.jpg', mime_type: 'image/jpeg' }]),
      ]),
      /Only Artists can submit Final Delivery/i,
    );
  } finally {
    await resetIdentity();
  }

  await setIdentity('authenticated', testIds.artist);
  try {
    await assert.rejects(
      database.query('select public.is_final_render_approved($1)', [commissionId]),
      /permission denied/i,
    );
  } finally {
    await resetIdentity();
  }

  const batch = await beginBatch(commissionId);
  const fileId = batch.files[0].file_id;
  const path = await reserveObject(batch.delivery_id, fileId);

  await setIdentity('authenticated', testIds.artist);
  try {
    const { rows } = await database.query(
      'select public.can_upload_final_delivery_object($1) as allowed',
      [path],
    );
    assert.equal(rows[0].allowed, true, 'unexpired reservations allow upload authorization');
  } finally {
    await resetIdentity();
  }

  await setIdentity('service_role', testIds.artist);
  try {
    const { rows } = await database.query(
      'select * from public.get_final_delivery_upload_targets($1, $2)',
      [batch.delivery_id, testIds.artist],
    );
    assert.equal(rows.length, 1, 'unexpired reservations return upload targets');
  } finally {
    await resetIdentity();
  }

  await setIdentity('authenticated', testIds.client);
  try {
    const { rows } = await database.query(
      'select name from storage.objects where name = $1',
      [path],
    );
    assert.equal(rows.length, 0, 'unverified uploads must not be readable by the Client');
    await assert.rejects(
      database.query(
        'insert into storage.objects (bucket_id, name) values ($1, $2)',
        ['commission-final-deliveries', path + '-client-write'],
      ),
      /row-level security|policy/i,
    );
  } finally {
    await resetIdentity();
  }

  await finalizeBatch(batch.delivery_id, fileId);
  await setIdentity('authenticated', testIds.client);
  try {
    const { rows } = await database.query(
      'select name from storage.objects where name = $1',
      [path],
    );
    assert.equal(rows.length, 1, 'assigned Client can read committed files');
  } finally {
    await resetIdentity();
  }

  await setIdentity('authenticated', testIds.clientTwo);
  try {
    const { rows } = await database.query(
      'select name from storage.objects where name = $1',
      [path],
    );
    assert.equal(rows.length, 0, 'unrelated Client cannot read committed files');
  } finally {
    await resetIdentity();
  }

  await setIdentity('authenticated', testIds.artist);
  try {
    const { rows } = await database.query(
      'select name from storage.objects where name = $1',
      [path],
    );
    assert.equal(rows.length, 1, 'assigned Artist can read committed files');
  } finally {
    await resetIdentity();
  }

  await setIdentity('authenticated', testIds.clientTwo);
  try {
    await assert.rejects(
      database.query('select public.accept_commission_final_delivery($1)', [batch.delivery_id]),
      /Not authorized for this Final Delivery/i,
    );
  } finally {
    await resetIdentity();
  }

  await setIdentity('authenticated', testIds.artist);
  try {
    await assert.rejects(
      database.query('select public.accept_commission_final_delivery($1)', [batch.delivery_id]),
      /Only Clients can accept Final Delivery/i,
    );
  } finally {
    await resetIdentity();
  }
});

test('PNG finalization succeeds with a reserved 244648-byte file and valid manifest', async () => {
  const commissionId = await createCommission({
    milestones: [{ name: 'Final Render', status: 'APPROVED' }],
  });
  const batch = await beginBatch(commissionId, [
    { filename: 'final.png', mime_type: 'image/png', size_bytes: 244648 },
  ]);
  const fileId = batch.files[0].file_id;
  await reserveObject(batch.delivery_id, fileId);

  await finalizeManifest(batch.delivery_id, [{
    file_id: fileId,
    mime_type: 'image/png',
    size_bytes: 244648,
    sha256: 'a'.repeat(64),
  }]);

  const batchState = await database.query(
    'select status, is_current from public.commission_final_deliveries where id = $1',
    [batch.delivery_id],
  );
  assert.equal(batchState.rows[0].status, 'AWAITING_CLIENT_REVIEW');
  assert.equal(batchState.rows[0].is_current, true);

  const fileState = await database.query(
    `select verification_status, verified_mime_type, file_size_bytes, sha256
     from public.commission_final_delivery_files
     where id = $1`,
    [fileId],
  );
  assert.deepEqual(fileState.rows[0], {
    verification_status: 'VERIFIED',
    verified_mime_type: 'image/png',
    file_size_bytes: 244648,
    sha256: 'a'.repeat(64),
  });
});

test('signed upload cutoff rejects the boundary while verification and finalization use reservation expiry', async () => {
  const commissionId = await createCommission();
  const batch = await beginBatch(commissionId);
  const fileId = batch.files[0].file_id;
  const path = await reserveObject(batch.delivery_id, fileId);

  for (const remaining of ['3 hours', '2 hours 59 minutes']) {
    await withReservationWindow(batch.delivery_id, remaining, 'authenticated', async () => {
      const { rows } = await database.query(
        'select public.can_upload_final_delivery_object($1) as allowed',
        [path],
      );
      assert.equal(rows[0].allowed, false, `${remaining} remaining must block new Storage authorization`);
    });

    await withReservationWindow(batch.delivery_id, remaining, 'service_role', async () => {
      await assert.rejects(
        database.query(
          'select * from public.get_final_delivery_upload_targets($1, $2)',
          [batch.delivery_id, testIds.artist],
        ),
        /FINAL_DELIVERY_UPLOAD_CUTOFF: Signed upload URLs require more than three hours/i,
      );
    });
  }

  await withReservationWindow(batch.delivery_id, '2 hours', 'service_role', async () => {
    const { rows } = await database.query(
      'select * from public.get_final_delivery_verification_targets($1, $2)',
      [batch.delivery_id, testIds.artist],
    );
    assert.equal(rows.length, 1, 'unexpired reservations remain available for verification');
  });

  await database.query(
    `update public.commission_final_deliveries
     set expires_at = now() + interval '2 hours'
     where id = $1`,
    [batch.delivery_id],
  );
  await finalizeBatch(batch.delivery_id, fileId);
  const { rows } = await database.query(
    'select status from public.commission_final_deliveries where id = $1',
    [batch.delivery_id],
  );
  assert.equal(rows[0].status, 'AWAITING_CLIENT_REVIEW', 'finalization uses reservation expiry, not the upload cutoff');
});

test('partial resubmission preserves the prior revision-requested current batch', async () => {
  const commissionId = await createCommission();
  const firstBatch = await beginBatch(commissionId);
  const firstFileId = firstBatch.files[0].file_id;
  await reserveObject(firstBatch.delivery_id, firstFileId);
  await finalizeBatch(firstBatch.delivery_id, firstFileId);

  await setIdentity('authenticated', testIds.client);
  try {
    await database.query('select public.request_commission_final_revision($1, $2)', [
      firstBatch.delivery_id,
      'Please adjust the color palette.',
    ]);
  } finally {
    await resetIdentity();
  }

  const retry = await beginBatch(commissionId, [
    { filename: 'final-a.jpg', mime_type: 'image/jpeg', size_bytes: 4 },
    { filename: 'final-b.png', mime_type: 'image/png', size_bytes: 4 },
  ]);
  const retryFileId = retry.files[0].file_id;
  await reserveObject(retry.delivery_id, retryFileId);

  await assert.rejects(
    finalizeBatch(retry.delivery_id, retryFileId),
    /Every reserved Final Delivery file must be verified/i,
  );

  const { rows } = await database.query(
    `select id, status, is_current
     from public.commission_final_deliveries
     where id in ($1, $2)
     order by attempt_number`,
    [firstBatch.delivery_id, retry.delivery_id],
  );
  assert.deepEqual(rows.map(({ status, is_current }) => ({ status, is_current })), [
    { status: 'REVISION_REQUESTED', is_current: true },
    { status: 'UPLOADING', is_current: false },
  ]);

  await setIdentity('service_role', testIds.artist);
  try {
    await database.query(
      'select public.abandon_commission_final_delivery_upload($1, $2)',
      [retry.delivery_id, testIds.artist],
    );
  } finally {
    await resetIdentity();
  }

  const secondRetry = await beginBatch(commissionId, [
    { filename: 'final-a.jpg', mime_type: 'image/jpeg', size_bytes: 4 },
    { filename: 'final-b.png', mime_type: 'image/png', size_bytes: 8 },
  ]);
  for (const file of secondRetry.files) {
    await reserveObject(secondRetry.delivery_id, file.file_id);
  }
  await finalizeManifest(secondRetry.delivery_id, [
    { file_id: secondRetry.files[0].file_id, mime_type: 'image/jpeg', size_bytes: 4, sha256: 'b'.repeat(64) },
    { file_id: secondRetry.files[1].file_id, mime_type: 'image/png', size_bytes: 8, sha256: 'c'.repeat(64) },
  ]);
  const history = await database.query(
    `select delivery.status, delivery.is_current, count(file.id)::int as file_count
     from public.commission_final_deliveries as delivery
     join public.commission_final_delivery_files as file on file.delivery_id = delivery.id
     where delivery.commission_id = $1
     group by delivery.id
     order by delivery.attempt_number`,
    [commissionId],
  );
  assert.deepEqual(history.rows, [
    { status: 'REVISION_REQUESTED', is_current: false, file_count: 1 },
    { status: 'ABANDONED', is_current: false, file_count: 2 },
    { status: 'AWAITING_CLIENT_REVIEW', is_current: true, file_count: 2 },
  ]);

  const abandoned = await database.query(
    'select status from public.commission_final_deliveries where id = $1',
    [retry.delivery_id],
  );
  assert.equal(abandoned.rows[0].status, 'ABANDONED');
});

test('expired partial uploads are claimable for cleanup without deleting delivery history', async () => {
  const commissionId = await createCommission();
  const previousBatch = await beginBatch(commissionId);
  const previousFileId = previousBatch.files[0].file_id;
  await reserveObject(previousBatch.delivery_id, previousFileId);
  await finalizeBatch(previousBatch.delivery_id, previousFileId);

  await setIdentity('authenticated', testIds.client);
  try {
    await database.query(
      'select public.request_commission_final_revision($1, $2)',
      [previousBatch.delivery_id, 'Please revise the final image.'],
    );
  } finally {
    await resetIdentity();
  }

  const batch = await beginBatch(commissionId);
  const fileId = batch.files[0].file_id;
  const path = await reserveObject(batch.delivery_id, fileId);
  await database.query(
    `update public.commission_final_deliveries
     set expires_at = now() - interval '1 minute'
     where id = $1`,
    [batch.delivery_id],
  );

  await setIdentity('service_role', testIds.artist);
  try {
    await assert.rejects(
      database.query(
        'select * from public.get_final_delivery_upload_targets($1, $2)',
        [batch.delivery_id, testIds.artist],
      ),
      /Final Delivery upload reservation has expired/i,
    );
  } finally {
    await resetIdentity();
  }

  await assert.rejects(
    finalizeBatch(batch.delivery_id, fileId),
    /Final Delivery upload session has expired/i,
  );

  await setIdentity('authenticated', testIds.artist);
  try {
    const { rows } = await database.query(
      'select public.can_upload_final_delivery_object($1) as allowed',
      [path],
    );
    assert.equal(rows[0].allowed, false, 'expired reservations cannot authorize Storage uploads');
    await assert.rejects(
      database.query(
        'insert into storage.objects (bucket_id, name) values ($1, $2)',
        ['commission-final-deliveries', path + '-expired'],
      ),
      /row-level security|policy/i,
    );
  } finally {
    await resetIdentity();
  }

  await setIdentity('service_role', testIds.artist);
  try {
    const { rows } = await database.query('select * from public.claim_expired_final_delivery_uploads()');
    const claimed = rows.find((row) => row.delivery_id === batch.delivery_id);
    assert.ok(claimed);
    assert.deepEqual(claimed.storage_paths, [path]);
    await database.query(
      'select public.complete_final_delivery_storage_cleanup($1)',
      [batch.delivery_id],
    );
  } finally {
    await resetIdentity();
  }

  const { rows } = await database.query(
    `select delivery.status, delivery.is_current, delivery.cleanup_completed_at,
            count(file.id)::int as file_count
     from public.commission_final_deliveries as delivery
     join public.commission_final_delivery_files as file on file.delivery_id = delivery.id
     where delivery.commission_id = $1
     group by delivery.id
     order by delivery.attempt_number`,
    [commissionId],
  );
  assert.deepEqual(rows.map(({ status, is_current, cleanup_completed_at, file_count }) => ({
    status,
    is_current,
    cleanup_completed: cleanup_completed_at !== null,
    file_count,
  })), [
    { status: 'REVISION_REQUESTED', is_current: true, cleanup_completed: false, file_count: 1 },
    { status: 'ABANDONED', is_current: false, cleanup_completed: true, file_count: 1 },
  ]);
});

test('completion keeps all existing safeguards and requires acceptance only when flagged', async (t) => {
  const baseCommission = async (options = {}) => createCommission({
    finalDeliveryRequired: false,
    milestones: [{ name: 'Final Render', status: 'APPROVED' }],
    deliverables: ['APPROVED'],
    ...options,
  });
  const completeAsClient = async (commissionId, actorId = testIds.client) => {
    await setIdentity('authenticated', actorId);
    try {
      return await database.query('select * from public.complete_commission($1)', [commissionId]);
    } finally {
      await resetIdentity();
    }
  };

  await t.test('legacy flag false commissions keep their existing completion path', async () => {
    const id = await baseCommission({ finalDeliveryRequired: false });
    const result = await completeAsClient(id);
    assert.equal(result.rows[0].status, 'COMPLETED');
  });

  await t.test('required delivery blocks completion until accepted', async () => {
    const id = await baseCommission({ finalDeliveryRequired: true });
    await assert.rejects(completeAsClient(id), /Final Delivery must be accepted/i);
  });

  await t.test('accepted delivery still requires explicit commission completion', async () => {
    const id = await baseCommission({ finalDeliveryRequired: true });
    const batch = await beginBatch(id);
    await reserveObject(batch.delivery_id, batch.files[0].file_id);
    await finalizeBatch(batch.delivery_id, batch.files[0].file_id);
    await acceptBatch(batch.delivery_id);
    const state = await database.query(
      'select status from public.commissions where id = $1',
      [id],
    );
    assert.equal(state.rows[0].status, 'IN_PROGRESS');
    const result = await completeAsClient(id);
    assert.equal(result.rows[0].status, 'COMPLETED');
  });

  await t.test('failed uploads remain exempt while approved deliverables are still required', async () => {
    const id = await baseCommission({ deliverables: ['APPROVED', 'FAILED'] });
    const result = await completeAsClient(id);
    assert.equal(result.rows[0].status, 'COMPLETED');
  });

  const safeguardCases = [
    ['requires milestones', { milestones: [] }, /must have milestones/i],
    ['requires all milestones approved', { milestones: [{ name: 'Final Render', status: 'PENDING' }] }, /All milestones must be approved/i],
    ['requires an approved deliverable', { deliverables: [] }, /at least one approved deliverable/i],
    ['rejects active unapproved deliverables', { deliverables: ['APPROVED', 'PENDING'] }, /All active deliverables must be approved/i],
    ['rejects unresolved revisions', { revisions: ['SUBMITTED'] }, /Resolve all revision requests/i],
    ['requires the assigned Client', { clientId: testIds.clientTwo }, /Not authorized for this commission/i],
  ];
  for (const [label, options, expected] of safeguardCases) {
    await t.test(label, async () => {
      const id = await baseCommission(options);
      await assert.rejects(completeAsClient(id), expected);
    });
  }

  await t.test('rejects Artist completion', async () => {
    const id = await baseCommission();
    await assert.rejects(completeAsClient(id, testIds.artist), /Only clients can complete commissions/i);
  });
});
