import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScreenShell } from '../components/ui/ScreenShell';
import { IconButton } from '../components/ui/IconButton';
import { isSupabaseConfigured } from '../lib/supabase';
import { listMyContentReportStatuses } from '../lib/supabaseData';
import type { MyContentReportStatus } from '../lib/supabaseData';

function formatStatus(value: string): string {
  return value.replaceAll('_', ' ').toLowerCase();
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function MyReportsPage() {
  const navigate = useNavigate();
  const [reports, setReports] = useState<MyContentReportStatus[]>([]);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState<string>();

  const loadReports = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setReports(await listMyContentReportStatuses());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load your reports.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isSupabaseConfigured) void loadReports();
  }, [loadReports]);

  return (
    <ScreenShell
      header={
        <div className="px-hd row-between">
          <div className="row gap-10">
            <IconButton icon="chevron-l" onClick={() => navigate('/profile/settings')} ariaLabel="Back to Settings" />
            <span className="h-title" style={{ fontSize: 19 }}>My Reports</span>
          </div>
        </div>
      }
    >
      {!isSupabaseConfigured ? (
        <div className="card t-sm c-mid" role="status">
          Report status tracking is unavailable in demo mode. Demo reports are not saved or sent.
        </div>
      ) : loading ? (
        <div className="card t-sm c-mid" role="status">Loading your reports…</div>
      ) : error ? (
        <div className="card t-sm c-danger" role="alert">
          <div>{error}</div>
          <button type="button" className="link-sm" onClick={() => void loadReports()}>Try again</button>
        </div>
      ) : reports.length === 0 ? (
        <div className="card t-sm c-mid" role="status">You have not submitted any reports.</div>
      ) : (
        <section aria-label="Your report statuses" style={{ display: 'grid', gap: 10 }}>
          {reports.map((report) => (
            <article className="card" key={report.id} style={{ padding: 16 }}>
              <div className="row-between gap-10">
                <strong className="t-sm">{report.target_type.replaceAll('_', ' ').toLowerCase()} report</strong>
                <span className={`badge ${report.status === 'OPEN' || report.status === 'IN_REVIEW' ? 'badge-warning' : 'badge-accent'}`}>
                  {formatStatus(report.status)}
                </span>
              </div>
              <div className="t-xs c-low" style={{ marginTop: 7 }}>
                {formatStatus(report.category)} · Submitted {formatDate(report.created_at)}
              </div>
            </article>
          ))}
        </section>
      )}
    </ScreenShell>
  );
}
