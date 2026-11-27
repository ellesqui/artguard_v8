import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../supabase/', import.meta.url);
const foundationSql = await readFile(new URL('commission-final-delivery-foundation.sql', root), 'utf8');
const activationSql = await readFile(new URL('commission-final-delivery-activation.sql', root), 'utf8');
const deprecatedSql = await readFile(new URL('commission-final-delivery.sql', root), 'utf8');
const serviceCreationSql = await readFile(new URL('commission-request-concurrency-hardening.sql', root), 'utf8');
const legacySelectionSql = await readFile(new URL('commission-post-selection.sql', root), 'utf8');
const legacyDirectSql = await readFile(new URL('revision-requests.sql', root), 'utf8');
const storageFunction = await readFile(new URL('functions/_shared/finalDeliveryStorage.ts', root), 'utf8');

function functionBody(sql, functionName) {
  const start = sql.search(new RegExp(`create or replace function public\\.${functionName}\\s*\\(`, 'i'));
  assert.notEqual(start, -1, `Missing function ${functionName}`);
  const bodyStart = sql.indexOf('as $$', start);
  const bodyEnd = sql.indexOf('$$;', bodyStart);
  assert.ok(bodyStart > start && bodyEnd > bodyStart, `Missing body for ${functionName}`);
  return sql.slice(start, bodyEnd);
}

test('foundation defaults final delivery off and does not replace supported creators', () => {
  assert.match(foundationSql, /add column if not exists final_delivery_required boolean not null default false/i);
  assert.doesNotMatch(foundationSql, /create or replace function public\.create_commission_request\s*\(/i);
  assert.doesNotMatch(foundationSql, /create or replace function public\.select_commission_post_applicant\s*\(/i);
  assert.doesNotMatch(foundationSql, /update public\.commissions[\s\S]*final_delivery_required/i);
});

test('foundation contains required tables, RPCs, policies, bucket, and trigger rerun safety', () => {
  assert.match(foundationSql, /create table if not exists public\.commission_final_deliveries/i);
  assert.match(foundationSql, /create table if not exists public\.commission_final_delivery_files/i);
  for (const rpc of [
    'is_final_render_approved',
    'begin_commission_final_delivery',
    'get_final_delivery_upload_targets',
    'get_final_delivery_verification_targets',
    'finalize_commission_final_delivery',
    'abandon_commission_final_delivery_upload',
    'accept_commission_final_delivery',
    'request_commission_final_revision',
    'list_commission_final_deliveries',
    'get_final_delivery_download_target',
  ]) {
    assert.match(foundationSql, new RegExp(`create or replace function public\\.${rpc}\\s*\\(`, 'i'));
  }
  assert.match(foundationSql, /create policy "Artists can upload reserved Final Delivery files"[\s\S]*on storage\.objects for insert/i);
  assert.match(foundationSql, /create policy "Participants can read committed Final Delivery files"[\s\S]*on storage\.objects for select/i);
  assert.doesNotMatch(foundationSql, /on storage\.objects for update/i);
  assert.doesNotMatch(foundationSql, /on storage\.objects for delete/i);
  assert.match(foundationSql, /41943040/);
  assert.match(foundationSql, /bucket\.file_size_limit = 41943040/i);
  assert.match(foundationSql, /array\['image\/jpeg', 'image\/png', 'application\/pdf'\]/i);
  assert.match(foundationSql, /drop trigger if exists commission_final_deliveries_guard_transition\s+on public\.commission_final_deliveries/i);
  assert.match(foundationSql, /drop trigger if exists commission_final_delivery_files_guard_update\s+on public\.commission_final_delivery_files/i);
  assert.equal((foundationSql.match(/drop trigger if exists/gi) ?? []).length, 2);
});

test('Final Render approval helper is not directly executable by API roles', () => {
  const normalized = foundationSql.replace(/\s+/g, ' ');
  assert.match(
    normalized,
    /revoke all on function public\.is_final_render_approved\(uuid\) from public, anon, authenticated, service_role/i,
  );
  assert.equal(
    (foundationSql.match(/grant execute on function public\.is_final_render_approved\(uuid\)\s+to\s+[^;]+;/gi) ?? []).length,
    0,
    'function ownership provides internal execution without explicit API-role grants',
  );
});

test('deprecated combined migration cannot execute silently', () => {
  assert.match(deprecatedSql, /DEPRECATED_FINAL_DELIVERY_COMBINED_MIGRATION/i);
  assert.match(deprecatedSql, /commission-final-delivery-foundation\.sql/i);
  assert.match(deprecatedSql, /commission-final-delivery-activation\.sql/i);
  assert.doesNotMatch(deprecatedSql, /alter table public\.commissions[\s\S]*add column/i);
});

test('activation replaces exactly two supported creator RPCs with exact signatures and defaults', () => {
  const directMatches = activationSql.match(/create or replace function public\.create_commission_request\s*\(/gi) ?? [];
  const publicMatches = activationSql.match(/create or replace function public\.select_commission_post_applicant\s*\(/gi) ?? [];
  assert.equal(directMatches.length, 1);
  assert.equal(publicMatches.length, 1);
  assert.match(activationSql, /create_commission_request\(\s*p_artist_id uuid,[\s\S]*p_target_deadline date default null,[\s\S]*p_client_budget numeric default null,[\s\S]*p_client_budget_currency text default null/i);
  assert.match(activationSql, /select_commission_post_applicant\(\s*p_commission_post_id uuid,[\s\S]*p_target_deadline date default null,[\s\S]*p_estimated_working_hours numeric default null/i);
  assert.match(activationSql, /returns jsonb/i);
  assert.match(activationSql, /returns public\.commissions/i);
  assert.doesNotMatch(activationSql, /create or replace function public\.create_service_commission_request/i);
  assert.doesNotMatch(activationSql, /create or replace function public\.select_commission_post_artist/i);
  assert.doesNotMatch(activationSql, /create or replace function public\.get_or_create_commission/i);
  assert.doesNotMatch(activationSql, /create or replace function public\.complete_commission/i);
});

test('activation only opts the two supported inserts into final delivery', () => {
  const direct = functionBody(activationSql, 'create_commission_request');
  const publicPost = functionBody(activationSql, 'select_commission_post_applicant');
  for (const body of [direct, publicPost]) {
    assert.match(body, /insert into public\.commissions[\s\S]*final_delivery_required/i);
    assert.match(body, /p_(?:target_deadline|estimated_working_hours)[\s\S]*true/i);
  }
  assert.match(direct, /'AWAITING_ARTIST', true/i);
  assert.match(publicPost, /p_estimated_working_hours,\s*true/i);
  assert.doesNotMatch(activationSql, /update public\.commissions[\s\S]*set[\s\S]*final_delivery_required/i);
});

test('activation preserves service, legacy post-selection, and legacy linking feature-off', () => {
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
    const insertColumns = body.match(/insert into public\.commissions\s*\(([\s\S]*?)\)\s*values/i)?.[1] ?? '';
    assert.doesNotMatch(insertColumns, /\bfinal_delivery_required\b/i);
  }
});

test('activation preserves owner and execute ACL for both RPCs', () => {
  const normalized = activationSql.replace(/\s+/g, ' ');
  for (const signature of [
    'public.create_commission_request(uuid, text, text, date, numeric, text)',
    'public.select_commission_post_applicant(uuid, uuid, numeric, text, date, numeric)',
  ]) {
    assert.match(normalized, new RegExp(`alter function ${signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} owner to postgres`, 'i'));
    assert.match(normalized, new RegExp(`revoke all on function ${signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} from public, anon, authenticated, service_role`, 'i'));
    assert.match(normalized, new RegExp(`grant execute on function ${signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} to authenticated, postgres`, 'i'));
  }
});

test('Final Render, Storage, and completion safeguards remain in foundation', () => {
  const normalizedFoundation = foundationSql.replace(/\s+/g, ' ');
  const approval = functionBody(foundationSql, 'is_final_render_approved');
  const begin = functionBody(foundationSql, 'begin_commission_final_delivery');
  const upload = functionBody(foundationSql, 'can_upload_final_delivery_object');
  const uploadTargets = functionBody(foundationSql, 'get_final_delivery_upload_targets');
  const verificationTargets = functionBody(foundationSql, 'get_final_delivery_verification_targets');
  const read = functionBody(foundationSql, 'can_read_final_delivery_object');
  const complete = functionBody(foundationSql, 'complete_commission');
  assert.match(approval, /milestone\.name = 'Final Render'/i);
  assert.match(approval, /milestone\.status = 'APPROVED'/i);
  assert.match(begin, /is_final_render_approved/i);
  assert.match(upload, /delivery\.status = 'UPLOADING'/i);
  assert.match(upload, /delivery\.expires_at > now\(\) \+ interval '3 hours'/i);
  assert.match(upload, /commission\.artist_id = auth\.uid\(\)/i);
  assert.match(uploadTargets, /delivery\.status = 'UPLOADING'/i);
  assert.match(uploadTargets, /delivery\.expires_at <= now\(\) \+ interval '3 hours'/i);
  assert.match(uploadTargets, /FINAL_DELIVERY_UPLOAD_CUTOFF/i);
  assert.match(verificationTargets, /delivery\.expires_at <= now\(\)/i);
  assert.doesNotMatch(verificationTargets, /interval '3 hours'/i);
  assert.match(
    normalizedFoundation,
    /revoke all on function public\.get_final_delivery_verification_targets\(uuid, uuid\) from public, anon, authenticated/i,
  );
  assert.match(
    normalizedFoundation,
    /grant execute on function public\.get_final_delivery_verification_targets\(uuid, uuid\) to service_role/i,
  );
  assert.match(read, /file\.verification_status = 'VERIFIED'/i);
  assert.match(complete, /v_role is distinct from 'client'/i);
  assert.match(complete, /for update/i);
  assert.match(complete, /commission_milestones[\s\S]*status <> 'APPROVED'/i);
  assert.match(complete, /commission_deliverables[\s\S]*status = 'APPROVED'/i);
  assert.match(complete, /status is distinct from 'APPROVED'[\s\S]*status is distinct from 'FAILED'/i);
  assert.match(complete, /revision_requests[\s\S]*status in \('OPEN', 'IN_PROGRESS', 'SUBMITTED'\)/i);
  assert.match(complete, /final_delivery_required[\s\S]*delivery\.is_current[\s\S]*delivery\.status = 'ACCEPTED'/i);
  assert.match(storageFunction, /createSignedUploadUrl\([\s\S]*upsert:\s*false/i);
  assert.match(storageFunction, /get_final_delivery_verification_targets/);
  assert.match(storageFunction, /New upload links are available only when more than three hours remain/);
});
