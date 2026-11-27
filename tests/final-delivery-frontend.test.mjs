import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  FINAL_DELIVERY_MAX_FILE_BYTES,
  canReviewCurrentFinalDelivery,
  canUploadFinalDelivery,
  canViewFinalDeliveryFile,
  finalDeliverySubmissionLabel,
  isFinalDeliveryEnabled,
  isFinalRenderApproved,
  validateFinalDeliveryFiles,
} from '../src/lib/finalDeliveryWorkflow.ts';

const artistUpload = {
  enabled: true,
  commissionStatus: 'IN_PROGRESS',
  artistId: 'artist-1',
  viewerId: 'artist-1',
  viewerRole: 'artist',
  finalRenderApproved: true,
  busy: false,
};

const clientReview = {
  commissionStatus: 'IN_PROGRESS',
  clientId: 'client-1',
  viewerId: 'client-1',
  viewerRole: 'client',
  deliveryStatus: 'AWAITING_CLIENT_REVIEW',
  isCurrent: true,
  busy: false,
};

test('Final Delivery is opt-in and legacy commissions remain feature-off', () => {
  assert.equal(isFinalDeliveryEnabled(true), true);
  assert.equal(isFinalDeliveryEnabled(false), false);
  assert.equal(isFinalDeliveryEnabled(undefined), false);
  assert.equal(isFinalDeliveryEnabled(null), false);
});

test('upload requires exactly one approved Final Render milestone', () => {
  assert.equal(isFinalRenderApproved([{ name: 'Final Render', status: 'APPROVED' }]), true);
  assert.equal(isFinalRenderApproved([{ name: 'Final Render', status: 'IN_PROGRESS' }]), false);
  assert.equal(isFinalRenderApproved([{ name: 'Final Render', status: 'APPROVED' }, { name: 'Final Render', status: 'APPROVED' }]), false);
  assert.equal(isFinalRenderApproved([{ name: 'Sketch', status: 'APPROVED' }]), false);
});

test('only the assigned Artist can upload on an active commission after approval', () => {
  assert.equal(canUploadFinalDelivery(artistUpload), true);
  assert.equal(canUploadFinalDelivery({ ...artistUpload, enabled: false }), false);
  assert.equal(canUploadFinalDelivery({ ...artistUpload, viewerRole: 'client' }), false);
  assert.equal(canUploadFinalDelivery({ ...artistUpload, viewerId: 'other-artist' }), false);
  assert.equal(canUploadFinalDelivery({ ...artistUpload, commissionStatus: 'COMPLETED' }), false);
  assert.equal(canUploadFinalDelivery({ ...artistUpload, finalRenderApproved: false }), false);
  assert.equal(canUploadFinalDelivery({ ...artistUpload, busy: true }), false);
});

test('only the Client can review the current delivery awaiting review', () => {
  assert.equal(canReviewCurrentFinalDelivery(clientReview), true);
  assert.equal(canReviewCurrentFinalDelivery({ ...clientReview, viewerRole: 'artist', viewerId: 'artist-1' }), false);
  assert.equal(canReviewCurrentFinalDelivery({ ...clientReview, viewerId: 'other-client' }), false);
  assert.equal(canReviewCurrentFinalDelivery({ ...clientReview, isCurrent: false }), false);
  assert.equal(canReviewCurrentFinalDelivery({ ...clientReview, deliveryStatus: 'REVISION_REQUESTED' }), false);
  assert.equal(canReviewCurrentFinalDelivery({ ...clientReview, commissionStatus: 'COMPLETED' }), false);
  assert.equal(canReviewCurrentFinalDelivery({ ...clientReview, busy: true }), false);
});

test('multiple allowed files are accepted and MIME/size limits are enforced per file', () => {
  const files = [
    { name: 'render.jpg', type: 'image/jpeg', size: 1024 },
    { name: 'turnaround.png', type: 'image/png', size: 2048 },
    { name: 'notes.pdf', type: 'application/pdf', size: FINAL_DELIVERY_MAX_FILE_BYTES },
  ];
  assert.equal(validateFinalDeliveryFiles(files), null);
  assert.match(validateFinalDeliveryFiles([]), /at least one/i);
  assert.match(validateFinalDeliveryFiles([{ ...files[0], type: 'image/gif' }]), /JPEG, PNG, or PDF/);
  assert.match(validateFinalDeliveryFiles([{ ...files[0], size: FINAL_DELIVERY_MAX_FILE_BYTES + 1 }]), /40 MiB/);
  assert.match(validateFinalDeliveryFiles([{ ...files[0], size: 0 }]), /40 MiB/);
});

test('uploading and server verification/submission states have explicit UI labels', () => {
  assert.match(finalDeliverySubmissionLabel('uploading'), /Uploading/);
  assert.match(finalDeliverySubmissionLabel('verifying'), /Verifying.*submitting/);
  assert.equal(finalDeliverySubmissionLabel('idle'), null);
});

test('participant downloads remain available for submitted and accepted history after completion', () => {
  assert.equal(canViewFinalDeliveryFile({ isParticipant: true, deliveryStatus: 'ACCEPTED' }), true);
  assert.equal(canViewFinalDeliveryFile({ isParticipant: true, deliveryStatus: 'REVISION_REQUESTED' }), true);
  assert.equal(canViewFinalDeliveryFile({ isParticipant: true, deliveryStatus: 'AWAITING_CLIENT_REVIEW' }), true);
  assert.equal(canViewFinalDeliveryFile({ isParticipant: false, deliveryStatus: 'ACCEPTED' }), false);
  assert.equal(canViewFinalDeliveryFile({ isParticipant: true, deliveryStatus: 'UPLOADING' }), false);
});

test('frontend service uses the migration RPCs and protected Edge Function actions', async () => {
  const service = await readFile(new URL('../src/lib/supabaseFinalDeliveries.ts', import.meta.url), 'utf8');
  const component = await readFile(new URL('../src/components/commission/FinalDeliverySection.tsx', import.meta.url), 'utf8');
  assert.match(service, /list_commission_final_deliveries/);
  assert.match(service, /begin_commission_final_delivery/);
  assert.match(service, /accept_commission_final_delivery/);
  assert.match(service, /request_commission_final_revision/);
  assert.match(service, /action: 'upload-url'/);
  assert.match(service, /action: 'verify-submit'/);
  assert.match(service, /action: 'download'/);
  assert.match(service, /uploadToSignedUrl[\s\S]*upsert: false/);
  assert.match(component, /Accept Delivery/);
  assert.match(component, /Request Revision/);
  assert.match(component, /maxLength=\{4000\}/);
  assert.match(component, /AWAITING_CLIENT_REVIEW/);
  assert.match(component, /REVISION_REQUESTED/);
  assert.match(component, /previous delivery history is unchanged/);
  assert.match(component, /multiple/);
});

test('workspace keeps one primary action visible and places mobile quote context before it', async () => {
  const page = await readFile(new URL('../src/pages/CommissionWorkspacePage.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/pages/CommissionWorkspacePage.css', import.meta.url), 'utf8');
  const requiredMarkup = [
    page.indexOf('<section className="workspace-next-action"'),
    page.indexOf('<main className="workspace-main-column">'),
    page.indexOf('<h2 id="workspace-brief-title">'),
    page.indexOf('<h2>Work Stages</h2>'),
    page.indexOf('<h2>Work-in-Progress &amp; Milestone Attachments</h2>'),
    page.indexOf('<FinalDeliverySection'),
    page.indexOf('className="workspace-mobile-overview"'),
    page.indexOf('<h2>Progress Updates</h2>'),
    page.indexOf('<summary>Transaction History'),
  ];
  assert.ok(requiredMarkup.every((index) => index >= 0));

  const mobileRules = css.match(/@media \(max-width: 999px\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(mobileRules);
  assert.match(mobileRules, /\.workspace-mobile-overview\s*\{[\s\S]*?order:\s*1/);
  assert.match(mobileRules, /\.workspace-next-action\s*\{\s*order:\s*2/);
  assert.match(mobileRules, /\.workspace-main-column\s*\{\s*order:\s*3/);
  assert.doesNotMatch(css, /\.workspace-next-action\s*\{\s*display:\s*none/);
  assert.doesNotMatch(css, /workspace-next-action-payment-required/);
  assert.match(page, /isClient && isQuoteAwaitingClient[\s\S]*?Accept Quote/);
  assert.match(page, /realCommission\.status === 'ACCEPTED' && isArtist[\s\S]*?Start Commission/);
  assert.match(page, /workspace-quote-payment-note[\s\S]*?no real money is transferred/i);
  assert.match(page, /workspace-currency-code[\s\S]*?realCommission\.proposed_currency/);
  const compactPaymentRules = css.slice(css.lastIndexOf('@media (max-width: 999px) {'));
  assert.match(compactPaymentRules, /\.workspace-commission-payment-card\s*\{\s*display:\s*flex/);
});

test('accepted pre-work state uses a compact notice and retains active work and Final Delivery gates', async () => {
  const page = await readFile(new URL('../src/pages/CommissionWorkspacePage.tsx', import.meta.url), 'utf8');
  assert.match(page, /realCommission\.status === 'ACCEPTED' && \(\s*<section className="workspace-pre-work-status"/);
  assert.match(page, /Work begins after payment confirmation and the Artist starts the commission/);
  assert.match(page, /realCommission\.status === 'IN_PROGRESS'\s*\|\|\s*realCommission\.status === 'REVISION_REQUESTED'/);
  assert.match(page, /finalDeliveryRequired && \['IN_PROGRESS', 'REVISION_REQUESTED', 'COMPLETED'\]/);
});

test('status freshness and modal keyboard handling use safe focus and dismiss rules', async () => {
  const page = await readFile(new URL('../src/pages/CommissionWorkspacePage.tsx', import.meta.url), 'utf8');
  const hook = await readFile(new URL('../src/components/ui/useDialogAccessibility.ts', import.meta.url), 'utf8');
  const finalDelivery = await readFile(new URL('../src/components/commission/FinalDeliverySection.tsx', import.meta.url), 'utf8');
  const reportDialog = await readFile(new URL('../src/components/ReportSubmissionDialog.tsx', import.meta.url), 'utf8');

  assert.match(page, /addEventListener\('focus', handleFocus\)/);
  assert.match(page, /addEventListener\('visibilitychange', handleVisibilityChange\)/);
  assert.match(page, /removeEventListener\('focus', handleFocus\)/);
  assert.match(page, /removeEventListener\('visibilitychange', handleVisibilityChange\)/);
  assert.match(page, /commissionStatusRefreshInFlight/);
  assert.match(hook, /event\.key === 'Escape'/);
  assert.match(hook, /event\.key !== 'Tab'/);
  assert.match(hook, /previousFocus\.focus\(\)/);
  assert.match(page, /canClose: !paymentActionLoading/);
  assert.match(finalDelivery, /useDialogAccessibility/);
  assert.match(reportDialog, /canClose: !submitting/);
});

test('legacy UI remains hidden and Final Delivery is only mounted behind the feature flag', async () => {
  const page = await readFile(new URL('../src/pages/CommissionWorkspacePage.tsx', import.meta.url), 'utf8');
  const section = await readFile(new URL('../src/components/commission/FinalDeliverySection.tsx', import.meta.url), 'utf8');
  assert.match(page, /finalDeliveryRequired && \['IN_PROGRESS', 'REVISION_REQUESTED', 'COMPLETED'\]/);
  assert.match(section, /if \(!enabled \|\| \(!isArtist && !isClient\)\) return null/);
  assert.match(page, /finalDeliveryAccepted/);
  assert.match(page, /Accept the current Final Delivery before completing/);
});
