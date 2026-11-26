import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getCommissionCompletionBlocker,
  getDeliverableCompletionBlocker,
  validateDirectCommissionQuote,
  validateOptionalCommissionBudget,
} from '../src/lib/commissionWorkflow.ts';
import {
  getInProgressCommissionNextAction,
  isCommissionDeliverableImagePath,
  shouldCollapsePaidPaymentPanel,
} from '../src/lib/commissionWorkspacePresentation.ts';

test('completion requires an approved deliverable and ignores failed upload attempts only after approval', () => {
  assert.equal(getDeliverableCompletionBlocker([]), 'no-approved-deliverable');
  assert.equal(getDeliverableCompletionBlocker(['FAILED']), 'no-approved-deliverable');
  assert.equal(getDeliverableCompletionBlocker(['APPROVED']), null);
  assert.equal(getDeliverableCompletionBlocker(['APPROVED', 'FAILED']), null);
  assert.equal(getDeliverableCompletionBlocker(['APPROVED', 'SUBMITTED']), 'deliverables-awaiting-review');
  assert.equal(getDeliverableCompletionBlocker(['APPROVED', 'PROCESSING']), 'deliverables-awaiting-review');
});

const readyForCompletion = {
  commissionStatus: 'IN_PROGRESS',
  deliverables: [{ status: 'APPROVED' }],
  deliverablesLoading: false,
  milestones: [{ status: 'APPROVED' }],
  milestonesLoading: false,
  revisions: [{ status: 'RESOLVED' }],
  revisionsLoading: false,
};

test('completion stays blocked while any required data is loading or unavailable', () => {
  assert.equal(getCommissionCompletionBlocker(readyForCompletion), null);
  assert.equal(getCommissionCompletionBlocker({ ...readyForCompletion, deliverablesLoading: true }), 'deliverables-loading');
  assert.equal(getCommissionCompletionBlocker({ ...readyForCompletion, milestonesLoading: true }), 'milestones-loading');
  assert.equal(getCommissionCompletionBlocker({ ...readyForCompletion, revisionsLoading: true }), 'revisions-loading');
  assert.equal(getCommissionCompletionBlocker({ ...readyForCompletion, deliverablesError: new Error('offline') }), 'deliverables-unavailable');
  assert.equal(getCommissionCompletionBlocker({ ...readyForCompletion, milestonesError: new Error('offline') }), 'milestones-unavailable');
  assert.equal(getCommissionCompletionBlocker({ ...readyForCompletion, revisionsError: new Error('offline') }), 'revisions-unavailable');
});

test('completion readiness also requires approved milestones, resolved revisions, and an active commission', () => {
  assert.equal(getCommissionCompletionBlocker({
    ...readyForCompletion,
    milestones: [{ status: 'SUBMITTED' }],
  }), 'milestones-incomplete');
  assert.equal(getCommissionCompletionBlocker({
    ...readyForCompletion,
    revisions: [{ status: 'SUBMITTED' }],
  }), 'revisions-unresolved');
  assert.equal(getCommissionCompletionBlocker({
    ...readyForCompletion,
    commissionStatus: 'ACCEPTED',
  }), 'commission-not-active');
});

test('an optional budget is omitted cleanly and validates its amount and currency when supplied', () => {
  assert.equal(validateOptionalCommissionBudget('', ''), undefined);
  assert.equal(validateOptionalCommissionBudget('1200.50', 'PHP'), undefined);
  assert.match(validateOptionalCommissionBudget('0', 'PHP') ?? '', /greater than zero/);
  assert.match(validateOptionalCommissionBudget('1200', 'peso') ?? '', /three-letter/);
});

test('direct quotes require valid price, currency, and positive finite working hours', () => {
  assert.equal(validateDirectCommissionQuote('1200.50', 'PHP', '3.5'), undefined);
  assert.match(validateDirectCommissionQuote('', 'PHP', '3') ?? '', /proposed price/);
  assert.match(validateDirectCommissionQuote('1200', 'peso', '3') ?? '', /three-letter/);
  assert.match(validateDirectCommissionQuote('1200', 'PHP', '0') ?? '', /positive number/);
  assert.match(validateDirectCommissionQuote('1200', 'PHP', 'Infinity') ?? '', /positive number/);
});

test('Artist prioritizes an in-progress Sketch while noting that Thumbnail awaits Client review', () => {
  const action = getInProgressCommissionNextAction({
    isArtist: true,
    isClient: false,
    completionReady: false,
    submittedDeliverableExists: false,
    activeMilestone: { name: 'Sketch', status: 'IN_PROGRESS' },
    submittedMilestone: { name: 'Thumbnail' },
    startableMilestone: null,
  });

  assert.equal(action.title, 'Continue Sketch');
  assert.match(action.description, /submit this stage when ready/i);
  assert.match(action.description, /Thumbnail is awaiting Client review/);
  assert.doesNotMatch(action.title, /Waiting for Client Review/);
});

test('Artist starts a pending Sketch after a submitted Thumbnail when the existing selector allows it', () => {
  const action = getInProgressCommissionNextAction({
    isArtist: true,
    isClient: false,
    completionReady: false,
    submittedDeliverableExists: false,
    activeMilestone: { name: 'Thumbnail', status: 'SUBMITTED' },
    submittedMilestone: { name: 'Thumbnail' },
    startableMilestone: { name: 'Sketch' },
  });

  assert.equal(action.title, 'Start Sketch');
  assert.equal(action.description, 'Begin the next work stage.');
});

test('Artist waits for Client review only when no milestone is startable', () => {
  const action = getInProgressCommissionNextAction({
    isArtist: true,
    isClient: false,
    completionReady: false,
    submittedDeliverableExists: false,
    activeMilestone: { name: 'Thumbnail', status: 'SUBMITTED' },
    submittedMilestone: { name: 'Thumbnail' },
    startableMilestone: null,
  });

  assert.equal(action.title, 'Waiting for Client Review');
  assert.match(action.description, /reviewing Thumbnail/);
  assert.doesNotMatch(action.description, /Start Sketch|submit this stage/);
});

test('Client reviews a submitted Thumbnail instead of receiving Artist-only Sketch guidance', () => {
  const action = getInProgressCommissionNextAction({
    isArtist: false,
    isClient: true,
    completionReady: false,
    submittedDeliverableExists: false,
    activeMilestone: { name: 'Sketch', status: 'IN_PROGRESS' },
    submittedMilestone: { name: 'Thumbnail' },
    startableMilestone: null,
  });

  assert.equal(action.title, 'Thumbnail Awaiting Your Approval');
  assert.match(action.description, /Review this stage/);
  assert.doesNotMatch(action.title, /Continue Sketch|Start Sketch/);
  assert.doesNotMatch(action.description, /submit this stage/i);
});

test('Artist action takes priority when another work stage is awaiting Client review', () => {
  const action = getInProgressCommissionNextAction({
    isArtist: true,
    isClient: false,
    completionReady: false,
    submittedDeliverableExists: false,
    activeMilestone: { name: 'Line Art', status: 'IN_PROGRESS' },
    submittedMilestone: { name: 'Thumbnail' },
    startableMilestone: null,
  });

  assert.equal(action.title, 'Continue Line Art');
  assert.match(action.description, /submit this stage when ready/i);
  assert.match(action.description, /Thumbnail is awaiting Client review/);
  assert.doesNotMatch(action.title, /Waiting for Client Review/);
});

test('only a matching paid payment without an available refund collapses the payment panel', () => {
  assert.equal(shouldCollapsePaidPaymentPanel({
    matchingPaymentIsPaid: true,
    canRefundPayment: false,
    paymentStatus: 'PAID',
  }), true);
  assert.equal(shouldCollapsePaidPaymentPanel({
    matchingPaymentIsPaid: true,
    canRefundPayment: true,
    paymentStatus: 'PAID',
  }), false);
  for (const paymentStatus of ['PENDING', 'FAILED', 'REFUNDED', 'VOIDED']) {
    assert.equal(shouldCollapsePaidPaymentPanel({
      matchingPaymentIsPaid: false,
      canRefundPayment: false,
      paymentStatus,
    }), false, `${paymentStatus} payment must keep the existing panel`);
  }
  assert.equal(shouldCollapsePaidPaymentPanel({
    matchingPaymentIsPaid: false,
    canRefundPayment: false,
    paymentStatus: 'PAID',
  }), false, 'an unverified PAID status must keep the existing panel');
  assert.equal(shouldCollapsePaidPaymentPanel({
    matchingPaymentIsPaid: false,
    canRefundPayment: false,
    paymentStatus: null,
  }), false, 'an unavailable payment status must keep the existing panel');
});

test('deliverable preview classification recognizes image paths without treating other files as images', () => {
  assert.equal(isCommissionDeliverableImagePath('artist/commissions/id/protected/final.png'), true);
  assert.equal(isCommissionDeliverableImagePath('artist/commissions/id/protected/final.JPG'), true);
  assert.equal(isCommissionDeliverableImagePath('artist/commissions/id/protected/final.pdf'), false);
  assert.equal(isCommissionDeliverableImagePath(null), false);
});
