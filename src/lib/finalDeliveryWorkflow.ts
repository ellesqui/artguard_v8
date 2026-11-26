export const FINAL_DELIVERY_MAX_FILE_BYTES = 40 * 1024 * 1024;
export const FINAL_DELIVERY_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
] as const;

export type FinalDeliveryMimeType = (typeof FINAL_DELIVERY_MIME_TYPES)[number];
export type FinalDeliverySubmissionStage = 'idle' | 'uploading' | 'verifying';

type FinalRenderMilestone = {
  name: string;
  status: string;
};

export function isFinalDeliveryEnabled(value: boolean | null | undefined): boolean {
  return value === true;
}

export function isFinalRenderApproved(milestones: readonly FinalRenderMilestone[]): boolean {
  const finalRenderMilestones = milestones.filter((milestone) => milestone.name === 'Final Render');
  return finalRenderMilestones.length === 1 && finalRenderMilestones[0].status === 'APPROVED';
}

export function canUploadFinalDelivery(input: {
  enabled: boolean;
  commissionStatus: string;
  artistId: string;
  viewerId: string;
  viewerRole: string;
  finalRenderApproved: boolean;
  busy: boolean;
}): boolean {
  return input.enabled
    && input.viewerRole === 'artist'
    && input.viewerId === input.artistId
    && ['IN_PROGRESS', 'REVISION_REQUESTED'].includes(input.commissionStatus)
    && input.finalRenderApproved
    && !input.busy;
}

export function canReviewCurrentFinalDelivery(input: {
  commissionStatus: string;
  clientId: string;
  viewerId: string;
  viewerRole: string;
  deliveryStatus: string;
  isCurrent: boolean;
  busy: boolean;
}): boolean {
  return input.viewerRole === 'client'
    && input.viewerId === input.clientId
    && ['IN_PROGRESS', 'REVISION_REQUESTED'].includes(input.commissionStatus)
    && input.deliveryStatus === 'AWAITING_CLIENT_REVIEW'
    && input.isCurrent
    && !input.busy;
}

export function canViewFinalDeliveryFile(input: {
  isParticipant: boolean;
  deliveryStatus: string;
}): boolean {
  return input.isParticipant
    && ['AWAITING_CLIENT_REVIEW', 'REVISION_REQUESTED', 'ACCEPTED'].includes(input.deliveryStatus);
}

export function validateFinalDeliveryFiles(
  files: readonly Pick<File, 'name' | 'type' | 'size'>[],
): string | null {
  if (files.length === 0) return 'Choose at least one file for Final Delivery.';

  for (const file of files) {
    if (!file.name.trim()) return 'Every Final Delivery file needs a filename.';
    if (!(FINAL_DELIVERY_MIME_TYPES as readonly string[]).includes(file.type)) {
      return 'Final Delivery files must be JPEG, PNG, or PDF.';
    }
    if (file.size < 1 || file.size > FINAL_DELIVERY_MAX_FILE_BYTES) {
      return 'Each Final Delivery file must be between 1 byte and 40 MiB.';
    }
  }

  return null;
}

export function finalDeliverySubmissionLabel(stage: FinalDeliverySubmissionStage): string | null {
  if (stage === 'uploading') return 'Uploading Final Delivery files…';
  if (stage === 'verifying') return 'Verifying files and submitting delivery…';
  return null;
}
