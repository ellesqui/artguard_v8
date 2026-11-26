import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../supabase/', import.meta.url);
const workflowSql = await readFile(new URL('commission-workflow-rpc-sync.sql', root), 'utf8');
const deadlineSql = await readFile(new URL('commission-target-deadline.sql', root), 'utf8');
const quoteSql = await readFile(new URL('commission-direct-quote-workflow.sql', root), 'utf8');
const paymentPreflightSql = await readFile(new URL('commission-direct-quote-payment-preflight.sql', root), 'utf8');
const paymentHelper = await readFile(new URL('../src/lib/supabasePayments.ts', import.meta.url), 'utf8');
const workspaceSource = await readFile(new URL('../src/pages/CommissionWorkspacePage.tsx', import.meta.url), 'utf8');

function functionBody(sql, functionName) {
  const signatureStart = sql.search(new RegExp(`create(?: or replace)? function public\\.${functionName}\\s*\\(`, 'i'));
  assert.notEqual(signatureStart, -1, `Missing function ${functionName}`);
  const bodyStart = sql.indexOf('as $$', signatureStart);
  assert.notEqual(bodyStart, -1, `Missing body for ${functionName}`);
  const bodyEnd = sql.indexOf('$$;', bodyStart);
  assert.notEqual(bodyEnd, -1, `Unterminated body for ${functionName}`);
  return sql.slice(signatureStart, bodyEnd);
}

test('database completion requires an approved deliverable and blocks every active unapproved status', () => {
  const body = functionBody(workflowSql, 'complete_commission');
  assert.match(body, /not exists\s*\([\s\S]*commission_deliverables[\s\S]*status\s*=\s*'APPROVED'/i);
  assert.match(body, /status is distinct from 'APPROVED'[\s\S]*status is distinct from 'FAILED'/i);
  assert.match(body, /commission_milestones[\s\S]*status <> 'APPROVED'/i);
  assert.match(body, /revision_requests[\s\S]*status in \('OPEN', 'IN_PROGRESS', 'SUBMITTED'\)/i);
});

test('both deadline RPCs reject past UTC calendar dates without timestamp-converting the input date', () => {
  const createRequest = functionBody(deadlineSql, 'create_commission_request');
  const selectApplicant = functionBody(deadlineSql, 'select_commission_post_applicant');
  for (const body of [createRequest, selectApplicant]) {
    assert.match(body, /p_target_deadline\s*<\s*\(now\(\)\s*at time zone 'UTC'\)::date/i);
    assert.match(body, /set search_path = pg_catalog, public, pg_temp/i);
  }
});

test('deadline preflight rejects an existing non-DATE, NOT NULL, or defaulted column', () => {
  assert.match(deadlineSql, /select data_type,\s*is_nullable,\s*column_default/i);
  assert.match(deadlineSql, /v_target_type is distinct from 'date'/i);
  assert.match(deadlineSql, /v_target_nullable is distinct from 'YES'/i);
  assert.match(deadlineSql, /v_target_default is not null/i);
  assert.match(deadlineSql, /add column if not exists target_deadline date/i);
});

test('new direct requests store budget separately and require an artist quote', () => {
  const body = functionBody(quoteSql, 'create_commission_request');
  assert.match(body, /client_budget,\s*client_budget_currency,\s*quote_status/i);
  assert.match(body, /'AWAITING_ARTIST'/);
  const insertColumns = body.match(/insert into public\.commissions\s*\(([\s\S]*?)\)\s*values/i)?.[1] ?? '';
  assert.doesNotMatch(insertColumns, /\bamount\b|\bcurrency\b/i);
  assert.doesNotMatch(quoteSql, /insert into public\.commission_payments/i);
});

test('quote proposal is restricted to the assigned Artist and persists validated proposal data', () => {
  const proposal = functionBody(quoteSql, 'propose_direct_commission_quote');
  assert.match(proposal, /for update/i);
  assert.match(proposal, /v_role is distinct from 'artist'/i);
  assert.match(proposal, /artist_id is distinct from v_user/i);
  assert.match(proposal, /quote_status <> 'AWAITING_ARTIST'/i);
  assert.match(proposal, /p_estimated_working_hours is null[\s\S]*p_estimated_working_hours <= 0/i);
  assert.match(proposal, /set proposed_amount = p_amount[\s\S]*proposed_currency = v_currency[\s\S]*estimated_working_hours = p_estimated_working_hours/i);
});

test('first quote acceptance is atomic and only the assigned Client can accept', () => {
  const acceptance = functionBody(quoteSql, 'accept_direct_commission_quote');
  assert.match(acceptance, /v_role is distinct from 'client'/i);
  assert.match(acceptance, /client_id is distinct from v_user/i);
  assert.match(acceptance, /quote_status <> 'PENDING_CLIENT'/i);
  assert.match(acceptance, /amount = commission\.proposed_amount[\s\S]*currency = commission\.proposed_currency/i);
  assert.match(acceptance, /set amount = commission\.proposed_amount[\s\S]*currency = commission\.proposed_currency[\s\S]*quote_status = 'ACCEPTED'[\s\S]*quote_accepted_at = now\(\)[\s\S]*status = 'ACCEPTED'[\s\S]*accepted_at = now\(\)/i);
  assert.match(acceptance, /insert into public\.notifications/i);
});

test('accepted quote retries return unchanged values without duplicate notification', () => {
  const acceptance = functionBody(quoteSql, 'accept_direct_commission_quote');
  const retryIndex = acceptance.indexOf("if v_commission.quote_status = 'ACCEPTED'");
  const requestStateIndex = acceptance.indexOf("if v_commission.status <> 'REQUESTED'", retryIndex);
  const notificationIndex = acceptance.indexOf('insert into public.notifications', retryIndex);
  assert.ok(retryIndex >= 0);
  assert.ok(requestStateIndex > retryIndex);
  assert.ok(notificationIndex > requestStateIndex);
  const retryBranch = acceptance.slice(retryIndex, requestStateIndex);
  assert.match(retryBranch, /status = 'ACCEPTED'[\s\S]*quote_accepted_at is not null[\s\S]*accepted_at is not null/i);
  assert.match(retryBranch, /amount is not distinct from v_commission\.proposed_amount/i);
  assert.match(retryBranch, /currency is not distinct from v_commission\.proposed_currency/i);
  assert.match(retryBranch, /return v_commission/i);
  assert.match(retryBranch, /raise exception 'The accepted quote no longer matches its saved proposal'/i);
  assert.ok(acceptance.indexOf('for update') < retryIndex, 'row lock serializes concurrent acceptance attempts');
});

test('legacy accept remains available while pending direct quotes cannot start', () => {
  const acceptRequest = functionBody(quoteSql, 'accept_commission_request');
  assert.match(acceptRequest, /quote_status <> 'NOT_REQUIRED'/i);
  assert.match(acceptRequest, /DIRECT_COMMISSION_QUOTE_REQUIRED/);

  const startCommission = functionBody(quoteSql, 'start_commission');
  assert.match(startCommission, /quote_status in \('AWAITING_ARTIST', 'PENDING_CLIENT'\)/i);
  assert.match(startCommission, /Only artists can start commissions/i);
  assert.match(startCommission, /commission\.artist_id <> v_user/i);
  assert.match(startCommission, /commission\.status <> 'ACCEPTED'/i);
});

test('quote-required direct Start Work requires the assigned parties and accepted quote price', () => {
  const startCommission = functionBody(quoteSql, 'start_commission');
  assert.match(startCommission, /or v_commission\.quote_status = 'ACCEPTED'/i);
  assert.match(startCommission, /payment\.commission_id = v_commission\.id/i);
  assert.match(startCommission, /payment\.payer_id = v_commission\.client_id/i);
  assert.match(startCommission, /payment\.payee_id = v_commission\.artist_id/i);
  assert.match(startCommission, /payment\.amount = v_commission\.amount/i);
  assert.match(startCommission, /payment\.currency = v_commission\.currency/i);
  assert.doesNotMatch(startCommission, /provider_verified_at/i);
  const directQuotePayment = startCommission.match(
    /v_commission\.service_id is null[\s\S]*?v_commission\.quote_status = 'ACCEPTED'[\s\S]*?\n\s*\)/
  )?.[0] ?? '';
  assert.match(directQuotePayment, /payment\.amount = v_commission\.proposed_amount/i);
  assert.match(directQuotePayment, /payment\.currency = v_commission\.proposed_currency/i);
});

test('quote-required direct Start Work requires paid demo markers and rejects refunded or voided payments', () => {
  const startCommission = functionBody(quoteSql, 'start_commission');
  const directQuotePayment = startCommission.match(
    /v_commission\.service_id is null[\s\S]*?v_commission\.quote_status = 'ACCEPTED'[\s\S]*?\n\s*\)/
  )?.[0] ?? '';
  assert.match(startCommission, /payment\.status = 'PAID'/i);
  assert.match(directQuotePayment, /payment\.provider = 'DEMO_SIMULATION'/i);
  assert.match(directQuotePayment, /payment\.demo_paid_at is not null/i);
  assert.match(directQuotePayment, /payment\.paid_at is not null/i);
  assert.match(directQuotePayment, /payment\.provider_reference is null/i);
  assert.match(startCommission, /payment\.refunded_at is null/i);
  assert.match(startCommission, /coalesce\(payment\.refunded_amount,\s*0\)\s*=\s*0/i);
  assert.doesNotMatch(startCommission, /payment\.voided_at/i);
  assert.ok(
    /payment\.status = 'PAID'/i.test(startCommission),
    'a VOIDED status cannot satisfy the required PAID predicate',
  );
  assert.ok(startCommission.indexOf("payment.status = 'PAID'") < startCommission.indexOf("set status = 'IN_PROGRESS'"));
});

test('service, public-post, and legacy direct payment rules remain separate', () => {
  const startCommission = functionBody(quoteSql, 'start_commission');
  assert.match(startCommission, /if v_commission\.service_id is not null\s+or v_commission\.public_post_id is not null\s+or v_commission\.quote_status = 'ACCEPTED' then/i);
  assert.match(startCommission, /v_commission\.service_id is not null\s+or v_commission\.public_post_id is not null/i);
  assert.match(startCommission, /if v_commission\.public_post_id is not null then[\s\S]*PUBLIC_POST_PROVENANCE_MISMATCH/i);
  assert.match(startCommission, /payment\.status = 'PAID'/i);
  assert.doesNotMatch(startCommission, /quote_status = 'NOT_REQUIRED'[\s\S]*PAYMENT_REQUIRED_BEFORE_START/i);
});

test('read-only payment preflight checks established Original columns only', () => {
  assert.match(paymentPreflightSql, /Original simulated-payment marker is demo_paid_at/i);
  assert.doesNotMatch(paymentPreflightSql, /provider_verified_at/i);
  for (const column of [
    'commission_id', 'payer_id', 'payee_id', 'amount', 'currency', 'status',
    'provider', 'provider_reference', 'paid_at', 'demo_paid_at', 'refunded_at', 'refunded_amount',
  ]) {
    assert.match(paymentPreflightSql, new RegExp(`\\('${column}',`));
  }
  assert.doesNotMatch(paymentPreflightSql, /\b(insert|update|delete|alter|drop|create|grant|revoke|do)\b/i);
});

test('commission-ID payment helper retains the atomic RPC contract', () => {
  const demoHelper = paymentHelper.match(/export async function simulateCommissionPaymentDemoSuccess\([\s\S]*?\n}/)?.[0] ?? '';
  assert.match(demoHelper, /simulate_commission_payment_demo_success[\s\S]*p_commission_id:\s*commissionId/i);
  assert.match(workspaceSource, /simulateCommissionPaymentDemoSuccess\(realCommission\.id\)/);
  assert.doesNotMatch(workspaceSource, /createCommissionPayment\s*\(/);
});

test('legacy direct path still avoids the new quote-only payment gate', () => {
  const startCommission = functionBody(quoteSql, 'start_commission');
  assert.match(startCommission, /if v_commission\.service_id is not null\s+or v_commission\.public_post_id is not null\s+or v_commission\.quote_status = 'ACCEPTED' then/i);
  assert.match(startCommission, /quote_status in \('AWAITING_ARTIST', 'PENDING_CLIENT'\)/i);
  assert.doesNotMatch(startCommission, /commission_demo_payment_config/i);
  assert.match(quoteSql, /grant execute on function public\.start_commission\(uuid\)\s+to authenticated/i);
});

test('completion UI readiness accounts for all loading and error states', () => {
  const readiness = workspaceSource.match(/getCommissionCompletionBlocker\(\{[\s\S]*?\n\s*\}\)/)?.[0] ?? '';
  assert.match(readiness, /deliverablesLoading/);
  assert.match(readiness, /deliverablesError/);
  assert.match(readiness, /milestonesLoading/);
  assert.match(readiness, /milestonesError/);
  assert.match(readiness, /revisionsLoading:\s*revisionRequestsLoading/);
  assert.match(readiness, /revisionsError:\s*revisionRequestsError/);
});
