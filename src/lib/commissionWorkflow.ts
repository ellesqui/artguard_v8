export type DeliverableCompletionBlocker =
  | 'no-approved-deliverable'
  | 'deliverables-awaiting-review'
  | null;

export type CommissionCompletionBlocker =
  | 'commission-not-active'
  | 'deliverables-loading'
  | 'milestones-loading'
  | 'revisions-loading'
  | 'deliverables-unavailable'
  | 'milestones-unavailable'
  | 'revisions-unavailable'
  | 'no-approved-deliverable'
  | 'deliverables-awaiting-review'
  | 'milestones-incomplete'
  | 'revisions-unresolved'
  | null;

export function getDeliverableCompletionBlocker(statuses: readonly string[]): DeliverableCompletionBlocker {
  if (!statuses.includes('APPROVED')) return 'no-approved-deliverable';
  if (statuses.some((status) => status !== 'APPROVED' && status !== 'FAILED')) {
    return 'deliverables-awaiting-review';
  }
  return null;
}

export function getCommissionCompletionBlocker(input: {
  commissionStatus: string;
  deliverables: readonly { status: string }[];
  deliverablesLoading: boolean;
  deliverablesError?: unknown;
  milestones: readonly { status: string }[];
  milestonesLoading: boolean;
  milestonesError?: unknown;
  revisions: readonly { status: string }[];
  revisionsLoading: boolean;
  revisionsError?: unknown;
}): CommissionCompletionBlocker {
  if (input.commissionStatus !== 'IN_PROGRESS' && input.commissionStatus !== 'REVISION_REQUESTED') {
    return 'commission-not-active';
  }
  if (input.deliverablesError) return 'deliverables-unavailable';
  if (input.milestonesError) return 'milestones-unavailable';
  if (input.revisionsError) return 'revisions-unavailable';
  if (input.deliverablesLoading) return 'deliverables-loading';
  if (input.milestonesLoading) return 'milestones-loading';
  if (input.revisionsLoading) return 'revisions-loading';
  if (input.milestones.length === 0 || input.milestones.some((milestone) => milestone.status !== 'APPROVED')) {
    return 'milestones-incomplete';
  }

  const deliverableBlocker = getDeliverableCompletionBlocker(
    input.deliverables.map((deliverable) => deliverable.status),
  );
  if (deliverableBlocker) return deliverableBlocker;
  if (input.revisions.some((revision) => revision.status !== 'RESOLVED')) {
    return 'revisions-unresolved';
  }
  return null;
}

function isValidMoney(value: string): boolean {
  return /^\d+(?:\.\d{1,2})?$/.test(value.trim()) && Number.isFinite(Number(value)) && Number(value) > 0;
}

export function validateOptionalCommissionBudget(amount: string, currency: string): string | undefined {
  if (!amount.trim()) return undefined;
  if (!isValidMoney(amount)) return 'Enter a budget greater than zero with up to two decimal places.';
  if (!/^[A-Z]{3}$/.test(currency.trim())) return 'Enter a three-letter currency code.';
  return undefined;
}

export function validateDirectCommissionQuote(
  amount: string,
  currency: string,
  estimatedHours: string,
): string | undefined {
  if (!isValidMoney(amount)) return 'Enter a proposed price greater than zero with up to two decimal places.';
  if (!/^[A-Z]{3}$/.test(currency.trim())) return 'Enter a three-letter currency code.';
  const hours = Number(estimatedHours);
  if (!estimatedHours.trim() || !Number.isFinite(hours) || hours <= 0) {
    return 'Estimated working hours must be a positive number.';
  }
  return undefined;
}
