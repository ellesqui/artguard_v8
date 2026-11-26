import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../supabase/', import.meta.url);
const sql = await readFile(new URL('commission-final-delivery.sql', root), 'utf8');
const serviceCreationSql = await readFile(new URL('commission-request-concurrency-hardening.sql', root), 'utf8');
const legacySelectionSql = await readFile(new URL('commission-post-selection.sql', root), 'utf8');
const legacyDirectSql = await readFile(new URL('revision-requests.sql', root), 'utf8');
const storageFunction = await readFile(
  new URL('functions/_shared/finalDeliveryStorage.ts', root),
  'utf8',
);

function functionBody(functionName) {
  const start = sql.search(new RegExp(`create or replace function public\\.${functionName}\\s*\\(`, 'i'));
  assert.notEqual(start, -1, `Missing function ${functionName}`);
  const bodyStart = sql.indexOf('as $$', start);
  const bodyEnd = sql.indexOf('$$;', bodyStart);
  assert.ok(bodyStart > start && bodyEnd > bodyStart, `Missing body for ${functionName}`);
  return sql.slice(start, bodyEnd);
}

test('legacy commissions default to no Final Delivery requirement and only supported creation paths opt in', () => {
  assert.match(sql, /add column if not exists final_delivery_required boolean not null default false/i);
  const direct = functionBody('create_commission_request');
  const publicPost = functionBody('select_commission_post_applicant');
  for (const body of [direct, publicPost]) {
    assert.match(body, /final_delivery_required/i);
    assert.match(body, /\btrue\b/i);
  }

  const service = serviceCreationSql.slice(
    serviceCreationSql.indexOf('create or replace function public.create_service_commission_request'),
    serviceCreationSql.indexOf('$$;', serviceCreationSql.indexOf('create or replace function public.create_service_commission_request')),
  );
  const legacySelection = legacySelectionSql.slice(
    legacySelectionSql.indexOf('create or replace function public.select_commission_post_artist'),
    legacySelectionSql.indexOf('$$;', legacySelectionSql.indexOf('create or replace function public.select_commission_post_artist')),
  );
  const legacyDirect = legacyDirectSql.slice(
    legacyDirectSql.indexOf('create or replace function public.get_or_create_commission'),
    legacyDirectSql.indexOf('$$;', legacyDirectSql.indexOf('create or replace function public.get_or_create_commission')),
  );
  for (const body of [service, legacySelection, legacyDirect]) {
    assert.ok(body.length > 0);
    const insertColumns = body.match(/insert into public\.commissions\s*\(([\s\S]*?)\)\s*values/i)?.[1] ?? '';
    assert.doesNotMatch(insertColumns, /\bfinal_delivery_required\b/i);
  }
});

test('Final Render approval gates new batches and uploads, without modifying milestone state', () => {
  const approval = functionBody('is_final_render_approved');
  const begin = functionBody('begin_commission_final_delivery');
  const targets = functionBody('get_final_delivery_upload_targets');
  const finalize = functionBody('finalize_commission_final_delivery');
  assert.match(approval, /milestone\.name = 'Final Render'/i);
  assert.match(approval, /milestone\.status = 'APPROVED'/i);
  for (const body of [begin, targets, finalize]) {
    assert.match(body, /is_final_render_approved/i);
  }
  assert.doesNotMatch(finalize, /update public\.commission_milestones/i);
});

test('separate batch history and explicit review transitions are enforced', () => {
  const transition = functionBody('guard_commission_final_delivery_transition');
  const begin = functionBody('begin_commission_final_delivery');
  const finalize = functionBody('finalize_commission_final_delivery');
  const revise = functionBody('request_commission_final_revision');
  assert.match(transition, /old\.status = 'UPLOADING'[\s\S]*'AWAITING_CLIENT_REVIEW', 'ABANDONED'/i);
  assert.match(transition, /old\.status = 'AWAITING_CLIENT_REVIEW'[\s\S]*'REVISION_REQUESTED', 'ACCEPTED'/i);
  assert.match(begin, /max\(delivery\.attempt_number\)[\s\S]*\+ 1/i);
  assert.match(finalize, /set is_current = false[\s\S]*status = 'REVISION_REQUESTED'/i);
  assert.match(finalize, /set status = 'AWAITING_CLIENT_REVIEW'[\s\S]*is_current = true/i);
  assert.match(revise, /v_role is distinct from 'client'/i);
  assert.match(revise, /v_commission\.client_id is distinct from v_user/i);
  assert.match(revise, /v_delivery\.status is distinct from 'AWAITING_CLIENT_REVIEW'/i);
});

test('Storage access is private, state-bound, participant-scoped, and disallows overwrites', () => {
  const upload = functionBody('can_upload_final_delivery_object');
  const read = functionBody('can_read_final_delivery_object');
  assert.match(sql, /'commission-final-deliveries',\s*'commission-final-deliveries',\s*false/i);
  assert.match(sql, /array\['image\/jpeg', 'image\/png', 'application\/pdf'\]/i);
  assert.match(sql, /41943040/i);
  assert.match(upload, /delivery\.status = 'UPLOADING'/i);
  assert.match(upload, /profile\.role = 'artist'/i);
  assert.match(upload, /commission\.artist_id = auth\.uid\(\)/i);
  assert.match(upload, /is_final_render_approved/i);
  assert.match(read, /file\.verification_status = 'VERIFIED'/i);
  assert.match(read, /commission\.artist_id = auth\.uid\(\)[\s\S]*commission\.client_id = auth\.uid\(\)/i);
  assert.match(sql, /create policy "Artists can upload reserved Final Delivery files"[\s\S]*on storage\.objects for insert/i);
  assert.match(sql, /create policy "Participants can read committed Final Delivery files"[\s\S]*on storage\.objects for select/i);
  assert.doesNotMatch(sql, /on storage\.objects for update/i);
  assert.doesNotMatch(sql, /on storage\.objects for delete/i);
  assert.match(storageFunction, /createSignedUploadUrl\([\s\S]*upsert:\s*false/i);
});

test('completion preserves existing safeguards and adds only the conditional accepted-delivery requirement', () => {
  const complete = functionBody('complete_commission');
  assert.match(complete, /v_role is distinct from 'client'/i);
  assert.match(complete, /v_commission\.client_id is distinct from v_user/i);
  assert.match(complete, /for update/i);
  assert.match(complete, /commission_milestones[\s\S]*status <> 'APPROVED'/i);
  assert.match(complete, /commission_deliverables[\s\S]*status = 'APPROVED'/i);
  assert.match(complete, /status is distinct from 'APPROVED'[\s\S]*status is distinct from 'FAILED'/i);
  assert.match(complete, /revision_requests[\s\S]*status in \('OPEN', 'IN_PROGRESS', 'SUBMITTED'\)/i);
  assert.match(complete, /final_delivery_required[\s\S]*delivery\.is_current[\s\S]*delivery\.status = 'ACCEPTED'/i);
  assert.match(complete, /insert into public\.notifications/i);
  assert.match(sql, /set search_path = pg_catalog, public, pg_temp[\s\S]*grant execute on function public\.complete_commission\(uuid\)\s+to authenticated/i);
});
