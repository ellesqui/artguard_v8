import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { isSupabaseConfigured } from '../lib/supabase';
import { submitContentReport } from '../lib/supabaseData';
import type { ContentReportCategory, ContentReportTargetType } from '../lib/supabaseData';
import { useAuth } from '../context/AuthContext';
import './ReportSubmissionDialog.css';

export interface ReportSubmissionTarget {
  type: ContentReportTargetType;
  id: string;
  label: string;
  demoOnly?: boolean;
}

const REPORT_CATEGORIES: Array<{ value: ContentReportCategory; label: string }> = [
  { value: 'SPAM', label: 'Spam or misleading content' },
  { value: 'HARASSMENT', label: 'Harassment or abuse' },
  { value: 'SCAM', label: 'Scam or fraud' },
  { value: 'INAPPROPRIATE', label: 'Inappropriate content' },
  { value: 'COPYRIGHT', label: 'Copyright or ownership concern' },
  { value: 'OTHER', label: 'Other concern' },
];

export function ReportSubmissionDialog({
  target,
  onClose,
  demoOnly = false,
}: {
  target: ReportSubmissionTarget | null;
  onClose: () => void;
  demoOnly?: boolean;
}) {
  const { user } = useAuth();
  const [category, setCategory] = useState<ContentReportCategory | ''>('');
  const [details, setDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    setCategory('');
    setDetails('');
    setSubmitting(false);
    setError(undefined);
    setConfirmed(false);
  }, [target?.id, target?.type]);

  if (!target) return null;
  const previewOnly = demoOnly || target.demoOnly === true;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanDetails = details.trim();
    if (!user) {
      setError('Sign in to submit a report.');
      return;
    }
    if (!category) {
      setError('Choose a report category.');
      return;
    }
    if (Array.from(cleanDetails).length > 2000) {
      setError('Details must be 2,000 characters or fewer.');
      return;
    }

    setSubmitting(true);
    setError(undefined);
    try {
      if (isSupabaseConfigured && !previewOnly) {
        await submitContentReport(target.type, target.id, category, cleanDetails || undefined);
      }
      setConfirmed(true);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not submit this report.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="report-dialog-backdrop"
      role="presentation"
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      <section
        className="report-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        {confirmed ? (
          <div className="report-dialog-confirmation" role="status">
            <h2 id="report-dialog-title">Thank you for reporting</h2>
            <p>
              {isSupabaseConfigured
                && !previewOnly
                ? 'Your report was submitted for moderation. You can track its status in My Reports.'
                : 'Demo preview only. No report was sent or saved.'}
            </p>
            <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>Done</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="row-between gap-10">
              <h2 id="report-dialog-title">Report {target.label}</h2>
              <button type="button" className="link-sm" onClick={onClose} disabled={submitting}>Cancel</button>
            </div>
            <p className="t-xs c-low">
              Reports are private. Choose the closest category and include only details relevant to your concern.
            </p>
            <label className="field-label" htmlFor="content-report-category">Category</label>
            <select
              id="content-report-category"
              className="input-field"
              value={category}
              onChange={(event) => {
                const nextCategory = REPORT_CATEGORIES.find((item) => item.value === event.target.value);
                setCategory(nextCategory?.value ?? '');
              }}
              required
              disabled={submitting}
            >
              <option value="">Choose a reason</option>
              {REPORT_CATEGORIES.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
            <label className="field-label" htmlFor="content-report-details">Additional details (optional)</label>
            <textarea
              id="content-report-details"
              className="textarea-field"
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              maxLength={2000}
              rows={4}
              placeholder="Share relevant context without including passwords or payment details."
              disabled={submitting}
            />
            <div className="report-dialog-count">{Array.from(details).length}/2,000</div>
            {error && <div className="report-dialog-error" role="alert">{error}</div>}
            {(!isSupabaseConfigured || previewOnly) && (
              <div className="report-dialog-demo-note" role="note">
                Demo mode: submitting only shows a preview; it does not save or send a report.
              </div>
            )}
            <div className="report-dialog-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={submitting}>Cancel</button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={submitting || !category}>
                {submitting ? 'Submitting…' : 'Confirm report'}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
