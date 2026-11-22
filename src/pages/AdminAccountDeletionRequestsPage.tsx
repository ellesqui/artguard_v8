import { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ScreenShell } from '../components/ui/ScreenShell';
import { IconButton } from '../components/ui/IconButton';
import { useAuth } from '../context/AuthContext';
import { useMockToast } from '../components/ui/MockToast';
import {
  getAccountDeletionRequestReview,
  listAccountDeletionRequestsForAdmin,
  reviewAccountDeletionRequest,
  type AccountDeletionRequestReviewDetail,
  type AccountDeletionRequestStatus,
  type AccountDeletionRequestSummary,
} from '../lib/supabaseData';
import './AdminAccountDeletionRequestsPage.css';

function formatDate(value: string | null): string {
  if (!value) return 'Not available';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatStatus(status: AccountDeletionRequestStatus): string {
  return status.replaceAll('_', ' ').toLowerCase();
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function AdminAccountDeletionRequestsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast, showToast } = useMockToast();
  const [requests, setRequests] = useState<AccountDeletionRequestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [selectedRequestId, setSelectedRequestId] = useState<string>();
  const [selectedRequest, setSelectedRequest] = useState<AccountDeletionRequestReviewDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [reason, setReason] = useState('');
  const [activeAction, setActiveAction] = useState<string>();

  const loadRequests = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    try {
      setRequests(await listAccountDeletionRequestsForAdmin());
    } catch (error) {
      setLoadError(errorMessage(error, 'Could not load account deletion requests.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user?.isAdmin === true) {
      void loadRequests();
    } else {
      setLoading(false);
    }
  }, [loadRequests, user?.isAdmin]);

  if (user?.isAdmin !== true) return <Navigate to="/home" replace />;

  const openRequest = async (requestId: string) => {
    setSelectedRequestId(requestId);
    setSelectedRequest(undefined);
    setDetailError(undefined);
    setReason('');
    setDetailLoading(true);
    try {
      setSelectedRequest(await getAccountDeletionRequestReview(requestId));
    } catch (error) {
      setDetailError(errorMessage(error, 'Could not load this request.'));
    } finally {
      setDetailLoading(false);
    }
  };

  const handleReview = async (action: 'IN_REVIEW' | 'APPROVED' | 'REJECTED') => {
    if (!selectedRequest || activeAction) return;
    const cleanReason = reason.trim();
    if (action !== 'IN_REVIEW' && !cleanReason) {
      setDetailError('A reason is required to approve or reject a request.');
      return;
    }
    if (action === 'APPROVED' && !window.confirm('Approve this request for future authorized processing? No account data will be deleted.')) return;
    if (action === 'REJECTED' && !window.confirm('Reject this account deletion request?')) return;

    setActiveAction(action);
    setDetailError(undefined);
    try {
      await reviewAccountDeletionRequest(
        selectedRequest.request_id,
        action,
        action === 'IN_REVIEW' ? undefined : cleanReason,
      );
      await loadRequests();
      setSelectedRequest(await getAccountDeletionRequestReview(selectedRequest.request_id));
      setReason('');
      showToast(action === 'IN_REVIEW' ? 'Request moved into review' : `Request ${formatStatus(action)}`);
    } catch (error) {
      setDetailError(errorMessage(error, 'The review action could not be completed.'));
    } finally {
      setActiveAction(undefined);
    }
  };

  return (
    <ScreenShell
      header={
        <div className="px-hd row-between">
          <div className="row gap-10">
            <IconButton
              icon="chevron-l"
              onClick={() => navigate('/profile/settings')}
              ariaLabel="Back to Settings"
            />
            <span className="h-title" style={{ fontSize: 19 }}>Account Deletion Requests</span>
          </div>
        </div>
      }
    >
      <main className="admin-deletion-page">
        <div className="card admin-deletion-notice">
          Approved requests remain stored for a future authorized retention process. This review page never deletes accounts or related data.
        </div>

        {loading && <div className="card t-sm c-mid" role="status">Loading deletion requests…</div>}
        {!loading && loadError && (
          <div className="card t-sm admin-deletion-error" role="alert">
            <div>{loadError}</div>
            <button type="button" className="link-sm" onClick={() => void loadRequests()}>Try again</button>
          </div>
        )}
        {!loading && !loadError && requests.length === 0 && (
          <div className="card t-sm c-mid admin-deletion-empty" role="status">
            No account deletion requests.
          </div>
        )}

        {!loading && requests.length > 0 && (
          <section className="admin-deletion-list" aria-label="Account deletion request list">
            {requests.map((request) => (
              <article className="card admin-deletion-card" key={request.request_id}>
                <div className="row-between gap-10">
                  <div>
                    <div className="t-sm fw-700">{request.requester_name}</div>
                    <div className="t-xs c-low">
                      {request.requester_username ? `@${request.requester_username}` : 'Username unavailable'}
                      {request.requester_role ? ` · ${request.requester_role}` : ''}
                    </div>
                  </div>
                  <span className={`admin-deletion-status status-${request.status.toLowerCase()}`}>
                    {formatStatus(request.status)}
                  </span>
                </div>
                <div className="t-xs c-low">Requested {formatDate(request.requested_at)}</div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm admin-deletion-open"
                  onClick={() => void openRequest(request.request_id)}
                  aria-label={`View request from ${request.requester_name}`}
                >
                  {selectedRequestId === request.request_id ? 'Refresh request details' : 'View request'}
                </button>
              </article>
            ))}
          </section>
        )}

        {selectedRequestId && (
          <section className="card admin-deletion-detail" aria-label="Selected deletion request">
            <div className="row-between gap-10">
              <h2 className="t-sm fw-700">Request details</h2>
              <button
                type="button"
                className="link-sm"
                onClick={() => {
                  setSelectedRequestId(undefined);
                  setSelectedRequest(undefined);
                  setDetailError(undefined);
                }}
              >
                Close
              </button>
            </div>
            {detailLoading && <div className="t-sm c-mid" role="status">Loading request details…</div>}
            {detailError && <div className="admin-deletion-error" role="alert">{detailError}</div>}
            {selectedRequest && (
              <>
                <div className="admin-deletion-detail-grid">
                  <div><span>Requester</span><strong>{selectedRequest.requester.name}</strong></div>
                  <div><span>Username</span><strong>{selectedRequest.requester.username ? `@${selectedRequest.requester.username}` : 'Unavailable'}</strong></div>
                  <div><span>Account type</span><strong>{selectedRequest.requester.role ?? 'Unavailable'}</strong></div>
                  <div><span>Requested</span><strong>{formatDate(selectedRequest.requested_at)}</strong></div>
                  <div><span>Current status</span><strong>{formatStatus(selectedRequest.status)}</strong></div>
                  <div><span>Lifecycle</span><strong>{selectedRequest.account_state.lifecycle_status.toLowerCase()}</strong></div>
                </div>

                <div className="admin-deletion-work">
                  <h3 className="t-xs fw-700">Relevant account state</h3>
                  <div>Active commissions: {selectedRequest.account_state.active_commissions}</div>
                  <div>Pending payments: {selectedRequest.account_state.pending_payments}</div>
                  <div>Open commission posts: {selectedRequest.account_state.open_commission_posts}</div>
                  <div>Pending applications: {selectedRequest.account_state.pending_applications}</div>
                </div>

                <div className="admin-deletion-history">
                  <h3 className="t-xs fw-700">Review history</h3>
                  {selectedRequest.review_history.length === 0 ? (
                    <div className="t-xs c-low">No review actions recorded.</div>
                  ) : selectedRequest.review_history.map((review, index) => (
                    <article className="admin-deletion-history-entry" key={`${review.action}-${review.reviewed_at}-${index}`}>
                      <div className="row-between gap-10">
                        <strong>{formatStatus(review.action)}</strong>
                        <span className="t-xs c-low">{formatDate(review.reviewed_at)}</span>
                      </div>
                      <div className="t-xs c-low">Reviewed by {review.reviewer_name}</div>
                      {review.reason && <p>{review.reason}</p>}
                    </article>
                  ))}
                </div>

                {selectedRequest.status === 'PENDING' && (
                  <div className="admin-deletion-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={Boolean(activeAction)}
                      onClick={() => void handleReview('IN_REVIEW')}
                    >
                      {activeAction === 'IN_REVIEW' ? 'Updating…' : 'Mark under review'}
                    </button>
                  </div>
                )}
                {selectedRequest.status === 'IN_REVIEW' && (
                  <div className="admin-deletion-decision">
                    <label className="field-label" htmlFor="deletion-review-reason">
                      Decision reason (required for approval or rejection)
                    </label>
                    <textarea
                      id="deletion-review-reason"
                      className="textarea-field"
                      value={reason}
                      maxLength={2000}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="Record the reason for this decision."
                      disabled={Boolean(activeAction)}
                    />
                    <div className="admin-deletion-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={Boolean(activeAction) || !reason.trim()}
                        onClick={() => void handleReview('APPROVED')}
                      >
                        {activeAction === 'APPROVED' ? 'Approving…' : 'Approve request'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={Boolean(activeAction) || !reason.trim()}
                        onClick={() => void handleReview('REJECTED')}
                      >
                        {activeAction === 'REJECTED' ? 'Rejecting…' : 'Reject request'}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        )}
        {toast}
      </main>
    </ScreenShell>
  );
}
