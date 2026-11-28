import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useDialogAccessibility } from '../ui/useDialogAccessibility';
import {
  canReviewCurrentFinalDelivery,
  canUploadFinalDelivery,
  canViewFinalDeliveryFile,
  finalDeliverySubmissionLabel,
  isFinalDeliveryEnabled,
  isFinalRenderApproved,
  validateFinalDeliveryFiles,
  type FinalDeliverySubmissionStage,
} from '../../lib/finalDeliveryWorkflow';
import {
  acceptFinalDelivery,
  beginFinalDelivery,
  downloadFinalDeliveryFile,
  listFinalDeliveries,
  requestFinalDeliveryRevision,
  uploadFinalDeliveryFile,
  verifyAndSubmitFinalDelivery,
  type FinalDelivery,
  type FinalDeliveryFile,
} from '../../lib/supabaseFinalDeliveries';
import type { CommissionMilestone } from '../../lib/supabaseMilestones';

interface FinalDeliverySectionProps {
  commissionId: string;
  commissionStatus: string;
  finalDeliveryRequired: boolean | null | undefined;
  artistId: string;
  clientId: string;
  viewerId: string;
  viewerRole: string;
  milestones: CommissionMilestone[];
  milestonesLoading: boolean;
  onAcceptanceStatusChange: (commissionId: string, loaded: boolean, accepted: boolean) => void;
  onNotice: (message: string) => void;
}

interface FilePreview {
  fileId: string;
  filename: string;
  mimeType: string;
  url: string;
}

function formatSubmittedAt(value: string | null): string {
  if (!value) return 'Submission date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Submission date unavailable' : date.toLocaleString();
}

function fileTypeLabel(file: FinalDeliveryFile): string {
  if (file.mime_type === 'application/pdf') return 'PDF';
  return file.mime_type === 'image/png' ? 'PNG image' : 'JPEG image';
}

function byteLabel(size: number): string {
  return `${(size / (1024 * 1024)).toFixed(size >= 1024 * 1024 ? 1 : 2)} MiB`;
}

function statusLabel(status: FinalDelivery['status']): string {
  switch (status) {
    case 'AWAITING_CLIENT_REVIEW': return 'Awaiting Client review';
    case 'REVISION_REQUESTED': return 'Revision requested';
    case 'ACCEPTED': return 'Accepted';
    case 'UPLOADING': return 'Uploading';
    case 'ABANDONED': return 'Expired';
  }
}

export function FinalDeliverySection({
  commissionId,
  commissionStatus,
  finalDeliveryRequired,
  artistId,
  clientId,
  viewerId,
  viewerRole,
  milestones,
  milestonesLoading,
  onAcceptanceStatusChange,
  onNotice,
}: FinalDeliverySectionProps) {
  const enabled = isFinalDeliveryEnabled(finalDeliveryRequired);
  const isArtist = viewerId === artistId && viewerRole === 'artist';
  const isClient = viewerId === clientId && viewerRole === 'client';
  const finalRenderApproved = isFinalRenderApproved(milestones);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadLock = useRef(false);
  const reviewLock = useRef(false);
  const [deliveries, setDeliveries] = useState<FinalDelivery[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [submissionStage, setSubmissionStage] = useState<FinalDeliverySubmissionStage>('idle');
  const [submissionError, setSubmissionError] = useState<string>();
  const [revisionReason, setRevisionReason] = useState('');
  const [reviewActionDeliveryId, setReviewActionDeliveryId] = useState<string>();
  const [fileActionId, setFileActionId] = useState<string>();
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string>();
  const previewDialogAccessibility = useDialogAccessibility({
    isOpen: preview !== null,
    onClose: () => setPreview(null),
  });

  const refreshHistory = useCallback(async () => {
    if (!enabled || (!isArtist && !isClient)) {
      setDeliveries([]);
      setHistoryError(undefined);
      setHistoryLoading(false);
      onAcceptanceStatusChange(commissionId, !enabled, false);
      return;
    }

    setHistoryLoading(true);
    setHistoryError(undefined);
    try {
      const rows = await listFinalDeliveries(commissionId);
      setDeliveries(rows);
      onAcceptanceStatusChange(
        commissionId,
        true,
        rows.some((delivery) => delivery.is_current && delivery.status === 'ACCEPTED'),
      );
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Could not load Final Delivery history.');
      onAcceptanceStatusChange(commissionId, false, false);
    } finally {
      setHistoryLoading(false);
    }
  }, [commissionId, enabled, isArtist, isClient, onAcceptanceStatusChange]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory, refreshVersion]);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview.url);
  }, [preview]);

  const currentDelivery = deliveries.find((delivery) => delivery.is_current);
  const visibleDeliveries = deliveries.filter((delivery) => canViewFinalDeliveryFile({
    isParticipant: isArtist || isClient,
    deliveryStatus: delivery.status,
  }));
  const busy = submissionStage !== 'idle' || reviewActionDeliveryId !== undefined;
  const canUpload = canUploadFinalDelivery({
    enabled,
    commissionStatus,
    artistId,
    viewerId,
    viewerRole,
    finalRenderApproved,
    busy,
  });
  const currentDeliveryCanBeReviewed = currentDelivery
    ? canReviewCurrentFinalDelivery({
      commissionStatus,
      clientId,
      viewerId,
      viewerRole,
      deliveryStatus: currentDelivery.status,
      isCurrent: currentDelivery.is_current,
      busy,
    })
    : false;

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (uploadLock.current || !canUpload) return;

    const validationError = validateFinalDeliveryFiles(files);
    if (validationError) {
      setSubmissionError(validationError);
      return;
    }

    uploadLock.current = true;
    setSubmissionError(undefined);
    setSubmissionStage('uploading');
    let deliveryId: string | undefined;
    try {
      const reservation = await beginFinalDelivery(commissionId, files);
      deliveryId = reservation.delivery_id;
      if (reservation.files.length !== files.length) {
        throw new Error('Final Delivery did not reserve every selected file.');
      }

      for (let index = 0; index < files.length; index += 1) {
        await uploadFinalDeliveryFile(deliveryId, reservation.files[index].file_id, files[index]);
      }

      setSubmissionStage('verifying');
      await verifyAndSubmitFinalDelivery(deliveryId);
      setSubmissionStage('idle');
      setRefreshVersion((version) => version + 1);
      onNotice('Final Delivery submitted for Client review.');
    } catch (error) {
      let acceptedByServer = false;
      if (deliveryId) {
        try {
          const rows = await listFinalDeliveries(commissionId);
          acceptedByServer = rows.some((delivery) =>
            delivery.delivery_id === deliveryId
            && delivery.status === 'AWAITING_CLIENT_REVIEW'
            && delivery.is_current);
        } catch {
          acceptedByServer = false;
        }
      }
      setSubmissionStage('idle');
      if (acceptedByServer) {
        setSubmissionError(undefined);
        setRefreshVersion((version) => version + 1);
        onNotice('Final Delivery submitted for Client review.');
      } else {
        setSubmissionError(error instanceof Error
          ? `${error.message} Previous delivery history is unchanged.`
          : 'Final Delivery could not be submitted. Previous delivery history is unchanged.');
        setRefreshVersion((version) => version + 1);
      }
    } finally {
      uploadLock.current = false;
    }
  };

  const handleReview = async (delivery: FinalDelivery, action: 'accept' | 'revise') => {
    if (reviewLock.current || !currentDeliveryCanBeReviewed || delivery.delivery_id !== currentDelivery?.delivery_id) return;
    const reason = revisionReason.trim();
    if (action === 'revise' && (!reason || reason.length > 4000)) return;

    reviewLock.current = true;
    setReviewActionDeliveryId(delivery.delivery_id);
    try {
      if (action === 'accept') {
        await acceptFinalDelivery(delivery.delivery_id);
        onNotice('Final Delivery accepted. Complete the commission separately when all work is approved.');
      } else {
        await requestFinalDeliveryRevision(delivery.delivery_id, reason);
        setRevisionReason('');
        onNotice('Final Delivery revision requested.');
      }
      setRefreshVersion((version) => version + 1);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Final Delivery review could not be saved.');
    } finally {
      reviewLock.current = false;
      setReviewActionDeliveryId(undefined);
    }
  };

  const handleDownload = async (file: FinalDeliveryFile) => {
    if (fileActionId) return;
    setFileActionId(file.file_id);
    try {
      const result = await downloadFinalDeliveryFile(file.file_id);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      anchor.rel = 'noreferrer';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Could not download this Final Delivery file.');
    } finally {
      setFileActionId(undefined);
    }
  };

  const handlePreview = async (file: FinalDeliveryFile) => {
    if (previewLoadingId) return;
    previewDialogAccessibility.rememberTrigger();
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
    setPreviewLoadingId(file.file_id);
    try {
      const result = await downloadFinalDeliveryFile(file.file_id);
      setPreview({
        fileId: file.file_id,
        filename: result.filename,
        mimeType: result.mimeType,
        url: URL.createObjectURL(result.blob),
      });
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Could not preview this Final Delivery file.');
    } finally {
      setPreviewLoadingId(undefined);
    }
  };

  if (!enabled || (!isArtist && !isClient)) return null;

  return (
    <section className="card workspace-final-delivery" id="commission-final-delivery" aria-labelledby="final-delivery-title">
      <div className="workspace-section-heading">
        <h2 id="final-delivery-title">Final Delivery</h2>
        <p>Final files are reviewed separately from Work Stages. Acceptance does not complete the commission.</p>
      </div>

      {isArtist && (
        <div className="workspace-final-delivery-upload">
          {!finalRenderApproved && (
            <p className="t-xs c-warning" role="status">
              {milestonesLoading
                ? 'Checking Final Render approval…'
                : 'Upload and submission unlock after the Final Render milestone is approved.'}
            </p>
          )}
          {currentDelivery?.status === 'REVISION_REQUESTED' && currentDelivery.revision_reason && (
            <div className="workspace-final-delivery-reason">
              <strong>Requested changes</strong>
              <p>{currentDelivery.revision_reason}</p>
            </div>
          )}
          <input
            ref={fileInputRef}
            className="workspace-final-delivery-file-input"
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            multiple
            onChange={(event) => void handleUpload(event)}
            aria-label="Choose Final Delivery files"
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={!canUpload || historyLoading}
          >
            {submissionStage === 'uploading'
              ? 'Uploading…'
              : submissionStage === 'verifying'
                ? 'Verifying and submitting…'
                : currentDelivery?.status === 'REVISION_REQUESTED'
                  ? 'Upload revised Final Delivery'
                  : 'Upload Final Delivery'}
          </button>
          <span className="t-xs c-low">JPEG, PNG, or PDF · maximum 40 MiB per file · select multiple files for one delivery.</span>
          {submissionStage !== 'idle' && (
            <div className="t-xs c-low" role="status" aria-live="polite">
              {finalDeliverySubmissionLabel(submissionStage)}
            </div>
          )}
          {submissionError && <div className="t-xs c-danger" role="alert">{submissionError}</div>}
        </div>
      )}

      {historyLoading && <div className="t-xs c-low" role="status">Loading Final Delivery history…</div>}
      {historyError && (
        <div className="workspace-final-delivery-error">
          <div className="t-xs c-danger" role="alert">{historyError}</div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRefreshVersion((version) => version + 1)}>
            Retry
          </button>
        </div>
      )}
      {!historyLoading && deliveries.length === 0 && !historyError && (
        <p className="t-xs c-low">No submitted Final Delivery yet.</p>
      )}

      {deliveries.length > 0 && (
        <div className="workspace-final-delivery-history">
          {visibleDeliveries.map((delivery) => (
            <article className="workspace-final-delivery-batch" key={delivery.delivery_id}>
              <div className="workspace-final-delivery-batch-heading">
                <div>
                  <h3>Submission {delivery.attempt_number}</h3>
                  <time>{formatSubmittedAt(delivery.submitted_at)}</time>
                </div>
                <span className={`badge ${delivery.status === 'ACCEPTED' ? 'badge-success' : delivery.status === 'REVISION_REQUESTED' ? 'badge-warning' : 'badge-accent'}`}>
                  {statusLabel(delivery.status)}{delivery.is_current ? ' · Current' : ''}
                </span>
              </div>
              {delivery.revision_reason && (
                <p className="workspace-final-delivery-reason">{delivery.revision_reason}</p>
              )}
              {delivery.files.length > 0 && (
                <ul className="workspace-final-delivery-files">
                  {delivery.files.map((file) => (
                    <li key={file.file_id}>
                      <div className="workspace-final-delivery-file-description">
                        <strong title={file.filename}>{file.filename}</strong>
                        <span>{fileTypeLabel(file)} · {byteLabel(file.size_bytes)}</span>
                      </div>
                      <div className="workspace-final-delivery-file-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void handlePreview(file)}
                          disabled={previewLoadingId !== undefined || fileActionId !== undefined}
                        >
                          {previewLoadingId === file.file_id ? 'Loading…' : 'Preview'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => void handleDownload(file)}
                          disabled={fileActionId !== undefined || previewLoadingId !== undefined}
                        >
                          {fileActionId === file.file_id ? 'Preparing…' : 'Download'}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {isClient && delivery.delivery_id === currentDelivery?.delivery_id && currentDeliveryCanBeReviewed && (
                <div className="workspace-final-delivery-review">
                  <label className="field-label" htmlFor={`final-delivery-reason-${delivery.delivery_id}`}>
                    Request a revision (optional unless requesting changes)
                  </label>
                  <textarea
                    id={`final-delivery-reason-${delivery.delivery_id}`}
                    className="textarea-field"
                    rows={3}
                    maxLength={4000}
                    value={revisionReason}
                    onChange={(event) => setRevisionReason(event.target.value)}
                    placeholder="Explain what needs to change."
                  />
                  <div className="workspace-final-delivery-review-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void handleReview(delivery, 'revise')}
                      disabled={busy || !revisionReason.trim() || revisionReason.trim().length > 4000}
                    >
                      {reviewActionDeliveryId === delivery.delivery_id ? 'Saving…' : 'Request Revision'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void handleReview(delivery, 'accept')}
                      disabled={busy}
                    >
                      {reviewActionDeliveryId === delivery.delivery_id ? 'Saving…' : 'Accept Delivery'}
                    </button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {preview && (
        <div className="workspace-final-delivery-preview-backdrop" role="presentation" onClick={() => setPreview(null)}>
          <section
            className="workspace-final-delivery-preview"
            role="dialog"
            aria-modal="true"
            aria-labelledby="final-delivery-preview-title"
            ref={previewDialogAccessibility.dialogRef}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="workspace-final-delivery-preview-heading">
              <h3 id="final-delivery-preview-title">{preview.filename}</h3>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPreview(null)}>Close</button>
            </div>
            {preview.mimeType === 'application/pdf'
              ? <iframe title={`Preview of ${preview.filename}`} src={preview.url} sandbox="allow-scripts" />
              : <img src={preview.url} alt={`Preview of ${preview.filename}`} />}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                const file = visibleDeliveries.flatMap((delivery) => delivery.files).find((item) => item.file_id === preview.fileId);
                if (file) void handleDownload(file);
              }}
            >
              Download file
            </button>
          </section>
        </div>
      )}
    </section>
  );
}
