import assert from 'node:assert/strict';
import test from 'node:test';
import { netCommissionPaymentAmount } from '../src/lib/commissionPaymentAccounting.ts';

test('uses the original paid amount when there is no refund', () => {
  assert.equal(netCommissionPaymentAmount({
    amount: 125,
    refunded_amount: null,
    refunded_at: null,
  }), 125);
});

test('subtracts partial refunds from the paid amount', () => {
  assert.equal(netCommissionPaymentAmount({
    amount: 125,
    refunded_amount: 45,
    refunded_at: '2026-11-26T00:00:00Z',
  }), 80);
});

test('returns zero for fully refunded or incomplete refund records', () => {
  assert.equal(netCommissionPaymentAmount({
    amount: 125,
    refunded_amount: 125,
    refunded_at: '2026-11-26T00:00:00Z',
  }), 0);
  assert.equal(netCommissionPaymentAmount({
    amount: 125,
    refunded_amount: null,
    refunded_at: '2026-11-26T00:00:00Z',
  }), 0);
});
