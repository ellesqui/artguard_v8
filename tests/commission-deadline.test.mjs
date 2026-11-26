import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dateOnlyEndOfDay,
  formatDateOnly,
  getUtcDateInputValue,
  validateOptionalTargetDeadline,
} from '../src/lib/commissionDeadline.ts';

test('formats a date input using the documented UTC calendar date', () => {
  assert.equal(getUtcDateInputValue(new Date('2026-01-09T23:00:00-08:00')), '2026-01-10');
  assert.equal(formatDateOnly('2026-01-09'), new Date(2026, 0, 9).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }));
  assert.equal(dateOnlyEndOfDay('2026-01-09')?.getUTCHours(), 23);
});

test('allows an omitted deadline and rejects invalid or past dates', () => {
  assert.equal(validateOptionalTargetDeadline('', '2026-01-09'), undefined);
  assert.equal(validateOptionalTargetDeadline('2026-01-09', '2026-01-09'), undefined);
  assert.equal(validateOptionalTargetDeadline('2026-01-08', '2026-01-09'), 'Target deadline cannot be in the past.');
  assert.equal(validateOptionalTargetDeadline('2026-02-29', '2026-01-09'), 'Choose a valid target deadline.');
  assert.equal(formatDateOnly('2026-02-29'), null);
});
