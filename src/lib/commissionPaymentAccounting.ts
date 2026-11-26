export interface RefundablePaymentAmount {
  amount: number;
  refunded_amount: number | null;
  refunded_at: string | null;
}

export function netCommissionPaymentAmount(payment: RefundablePaymentAmount): number {
  const amount = Number(payment.amount);
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  if (payment.refunded_amount === null) {
    return payment.refunded_at ? 0 : amount;
  }

  const refundedAmount = Number(payment.refunded_amount);
  if (!Number.isFinite(refundedAmount) || refundedAmount < 0) return 0;
  return Math.max(0, amount - Math.min(refundedAmount, amount));
}
