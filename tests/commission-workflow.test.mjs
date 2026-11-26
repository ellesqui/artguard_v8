import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getCommissionCompletionBlocker,
  getDeliverableCompletionBlocker,
  validateDirectCommissionQuote,
  validateOptionalCommissionBudget,
} from '../src/lib/commissionWorkflow.ts';

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
