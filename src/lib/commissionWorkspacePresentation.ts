export interface WorkspaceMilestone {
  name: string;
  status: string;
}

export interface CommissionWorkspaceNextAction {
  title: string;
  description: string;
}

export function shouldCollapsePaidPaymentPanel(input: {
  matchingPaymentIsPaid: boolean;
  canRefundPayment: boolean;
  paymentStatus: string | null;
}): boolean {
  return input.paymentStatus === 'PAID'
    && input.matchingPaymentIsPaid
    && !input.canRefundPayment;
}

export function isCommissionDeliverableImagePath(path: string | null): boolean {
  return /\.(?:png|jpe?g|gif|webp|avif)$/i.test(path ?? '');
}

export function getInProgressCommissionNextAction(input: {
  isArtist: boolean;
  isClient: boolean;
  completionReady: boolean;
  submittedDeliverableExists: boolean;
  activeMilestone: WorkspaceMilestone | null;
  submittedMilestone: Pick<WorkspaceMilestone, 'name'> | null;
  startableMilestone: Pick<WorkspaceMilestone, 'name'> | null;
}): CommissionWorkspaceNextAction {
  if (input.completionReady && input.isClient) {
    return {
      title: 'All Required Work Approved — Ready to Complete',
      description: 'All deliverables, milestones, and revisions are clear. You can close the commission.',
    };
  }
  if (input.submittedDeliverableExists && input.isClient) {
    return {
      title: 'Artwork Submitted — Awaiting Your Review',
      description: 'Review the submitted deliverable below and approve it or request a revision.',
    };
  }
  if (input.submittedMilestone && input.isClient) {
    return {
      title: `${input.submittedMilestone.name} Awaiting Your Approval`,
      description: 'Review this stage and approve it when it meets the agreed requirements.',
    };
  }
  if (input.isArtist && input.activeMilestone?.status === 'IN_PROGRESS') {
    return {
      title: `Continue ${input.activeMilestone.name}`,
      description: input.submittedMilestone
        ? `Add an optional note and submit this stage when ready. ${input.submittedMilestone.name} is awaiting Client review.`
        : 'Add an optional note, then submit this stage when it is ready for Client review.',
    };
  }
  if (input.submittedMilestone && input.isArtist && !input.startableMilestone) {
    return {
      title: 'Waiting for Client Review',
      description: `The Client is reviewing ${input.submittedMilestone.name}.`,
    };
  }
  if (input.isArtist) {
    return {
      title: input.activeMilestone
        ? input.startableMilestone ? `Start ${input.startableMilestone.name}` : `Continue ${input.activeMilestone.name}`
        : 'Continue the commission',
      description: input.startableMilestone
        ? 'Begin the next work stage.'
        : input.activeMilestone
          ? 'Add an optional note, then submit this stage when it is ready for Client review.'
          : 'Continue the work and submit artwork for Client review in Deliverables below.',
    };
  }
  return {
    title: input.activeMilestone ? `Artist is preparing ${input.activeMilestone.name}` : 'Your Artist is working on this commission',
    description: input.activeMilestone
      ? "You'll be notified when this stage is ready."
      : 'Progress updates and work-stage reviews will appear below.',
  };
}
