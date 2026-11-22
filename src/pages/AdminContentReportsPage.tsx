import { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ScreenShell } from '../components/ui/ScreenShell';
import { IconButton } from '../components/ui/IconButton';
import { useAuth } from '../context/AuthContext';
import { useMockToast } from '../components/ui/MockToast';
import {
  getContentReportDetail,
  listContentReportsForAdmin,
  reviewContentReport,
} from '../lib/supabaseData';
import type {
  AdminContentReportDetail,
  AdminContentReportSummary,
  ContentReportStatus,
  ContentReportTargetType,
} from '../lib/supabaseData';
import './AdminContentReportsPage.css';

const STATUSES: ContentReportStatus[] = ['OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED'];
const TARGET_TYPES: ContentReportTargetType[] = ['PROFILE', 'ARTWORK', 'COMMISSION_POST', 'COMMISSION'];

function formatStatus(value: string): string {
  return value.replaceAll('_', ' ').toLowerCase();
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function AdminContentReportsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast, showToast } = useMockToast();
  const [statusFilter, setStatusFilter] = useState<ContentReportStatus | ''>('');
  const [typeFilter, setTypeFilter] = useState<ContentReportTargetType | ''>('');
  const [reports, setReports] = useState<AdminContentReportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<AdminContentReportDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [reason, setReason] = useState('');
  const [activeAction, setActiveAction] = useState<string>();

  const loadReports = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    try {
      setReports(await listContentReportsForAdmin(statusFilter || null, typeFilter || null));
    } catch (error) {
      setLoadError(readableError(error, 'Could not load the moderation queue.'));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter]);

  useEffect(() => {
    if (user?.isAdmin === true) void loadReports();
    else setLoading(false);
  }, [loadReports, user?.isAdmin]);

  if (user?.isAdmin !== true) return <Navigate to="/home" replace />;

  const openReport = async (reportId: string) => {
    setSelectedId(reportId);
    setDetail(undefined);
    setDetailError(undefined);
    setReason('');
    setDetailLoading(true);
    try {
      setDetail(await getContentReportDetail(reportId));
    } catch (error) {
      setDetailError(readableError(error, 'Could not load this report.'));
    } finally {
      setDetailLoading(false);
    }
  };

  const handleReview = async (action: 'IN_REVIEW' | 'RESOLVED' | 'DISMISSED') => {
    if (!detail || activeAction) return;
    const cleanReason = reason.trim();
    if (action !== 'IN_REVIEW' && !cleanReason) {
      setDetailError('An explanation is required to resolve or dismiss a report.');
      return;
    }
    if (action === 'RESOLVED' && !window.confirm('Resolve this report? No account, content, commission, or payment state will be changed.')) return;
    if (action === 'DISMISSED' && !window.confirm('Dismiss this report? The report and its history will be retained.')) return;

    setActiveAction(action);
    setDetailError(undefined);
    try {
      await reviewContentReport(detail.report_id, action, cleanReason || undefined);
      await loadReports();
      setDetail(await getContentReportDetail(detail.report_id));
      setReason('');
      showToast(action === 'IN_REVIEW' ? 'Report moved into review' : `Report ${formatStatus(action)}`);
    } catch (error) {
      setDetailError(readableError(error, 'The moderation action could not be completed.'));
    } finally {
      setActiveAction(undefined);
    }
  };

  return (
    <ScreenShell
      header={
        <div className="px-hd row-between">
          <div className="row gap-10">
            <IconButton icon="chevron-l" onClick={() => navigate('/profile/settings')} ariaLabel="Back to Settings" />
            <span className="h-title" style={{ fontSize: 19 }}>Reports &amp; Moderation</span>
          </div>
        </div>
      }
    >
      <main className="admin-content-reports">
        <div className="card admin-content-reports-notice">
          This queue records review decisions only. It does not hide content, suspend accounts, or change commissions or payments.
        </div>

        <div className="admin-content-report-filters">
          <label>
            <span className="field-label">Status</span>
            <select
              className="input-field"
              value={statusFilter}
              onChange={(event) => setStatusFilter(STATUSES.find((status) => status === event.target.value) ?? '')}
            >
              <option value="">All statuses</option>
              {STATUSES.map((status) => <option key={status} value={status}>{formatStatus(status)}</option>)}
            </select>
          </label>
          <label>
            <span className="field-label">Report type</span>
            <select
              className="input-field"
              value={typeFilter}
              onChange={(event) => setTypeFilter(TARGET_TYPES.find((type) => type === event.target.value) ?? '')}
            >
              <option value="">All types</option>
              {TARGET_TYPES.map((type) => <option key={type} value={type}>{formatStatus(type)}</option>)}
            </select>
          </label>
        </div>

        {loading && <div className="card t-sm c-mid" role="status">Loading reports…</div>}
        {!loading && loadError && (
          <div className="card t-sm admin-content-report-error" role="alert">
            <div>{loadError}</div>
            <button type="button" className="link-sm" onClick={() => void loadReports()}>Try again</button>
          </div>
        )}
        {!loading && !loadError && reports.length === 0 && (
          <div className="card t-sm c-mid" role="status">No reports match these filters.</div>
        )}
        {!loading && reports.length > 0 && (
          <section className="admin-content-report-list" aria-label="Moderation queue">
            {reports.map((report) => (
              <article className="card admin-content-report-card" key={report.report_id}>
                <div className="row-between gap-10">
                  <div>
                    <div className="t-sm fw-700">{report.target_label}</div>
                    <div className="t-xs c-low">
                      {formatStatus(report.target_type)} · {formatStatus(report.category)} · Reported by {report.reporter_name}
                    </div>
                  </div>
                  <span className={`badge ${report.status === 'OPEN' || report.status === 'IN_REVIEW' ? 'badge-warning' : 'badge-accent'}`}>
                    {formatStatus(report.status)}
                  </span>
                </div>
                <div className="t-xs c-low">Submitted {formatDate(report.created_at)}</div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openReport(report.report_id)}>
                  {selectedId === report.report_id ? 'Refresh details' : 'Review report'}
                </button>
              </article>
            ))}
          </section>
        )}

        {selectedId && (
          <section className="card admin-content-report-detail" aria-label="Selected report details">
            <div className="row-between gap-10">
              <h2 className="t-sm fw-700">Report details</h2>
              <button type="button" className="link-sm" onClick={() => { setSelectedId(undefined); setDetail(undefined); }}>
                Close
              </button>
            </div>
            {detailLoading && <div className="t-sm c-mid" role="status">Loading report…</div>}
            {detailError && <div className="admin-content-report-error" role="alert">{detailError}</div>}
            {detail && (
              <>
                <dl className="admin-content-report-facts">
                  <div><dt>Target</dt><dd>{detail.target_label}</dd></div>
                  <div><dt>Report type</dt><dd>{formatStatus(detail.target_type)}</dd></div>
                  <div><dt>Category</dt><dd>{formatStatus(detail.category)}</dd></div>
                  <div><dt>Status</dt><dd>{formatStatus(detail.status)}</dd></div>
                  <div><dt>Reporter</dt><dd>{detail.reporter.name}{detail.reporter.username ? ` (@${detail.reporter.username})` : ''}</dd></div>
                  <div><dt>Submitted</dt><dd>{formatDate(detail.created_at)}</dd></div>
                </dl>
                <div className="admin-content-report-message">
                  <h3 className="t-xs fw-700">Reporter details</h3>
                  <p>{detail.details || 'No additional details provided.'}</p>
                </div>
                <div className="admin-content-report-history">
                  <h3 className="t-xs fw-700">Moderation history</h3>
                  {detail.review_history.length === 0 ? (
                    <div className="t-xs c-low">No moderation actions recorded.</div>
                  ) : detail.review_history.map((review, index) => (
                    <article key={`${review.action}-${review.reviewed_at}-${index}`}>
                      <div className="row-between gap-10">
                        <strong>{formatStatus(review.action)}</strong>
                        <span className="t-xs c-low">{formatDate(review.reviewed_at)}</span>
                      </div>
                      <div className="t-xs c-low">Reviewed by {review.reviewer_name}</div>
                      {review.reason && <p>{review.reason}</p>}
                    </article>
                  ))}
                </div>
                {detail.status === 'OPEN' && (
                  <div className="admin-content-report-actions">
                    <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(activeAction)} onClick={() => void handleReview('IN_REVIEW')}>
                      {activeAction === 'IN_REVIEW' ? 'Updating…' : 'Mark under review'}
                    </button>
                  </div>
                )}
                {detail.status === 'IN_REVIEW' && (
                  <div className="admin-content-report-decision">
                    <label className="field-label" htmlFor="moderation-reason">
                      Explanation (required to resolve or dismiss)
                    </label>
                    <textarea
                      id="moderation-reason"
                      className="textarea-field"
                      value={reason}
                      maxLength={2000}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="Record the moderation decision and relevant reason."
                      disabled={Boolean(activeAction)}
                    />
                    <div className="admin-content-report-actions">
                      <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(activeAction) || !reason.trim()} onClick={() => void handleReview('RESOLVED')}>
                        {activeAction === 'RESOLVED' ? 'Resolving…' : 'Resolve report'}
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm" disabled={Boolean(activeAction) || !reason.trim()} onClick={() => void handleReview('DISMISSED')}>
                        {activeAction === 'DISMISSED' ? 'Dismissing…' : 'Dismiss report'}
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
