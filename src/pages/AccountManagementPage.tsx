import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScreenShell } from '../components/ui/ScreenShell';
import { IconButton } from '../components/ui/IconButton';
import { SettingsRow } from './SettingsPage';
import { AuthButton } from '../components/auth/AuthButton';
import { Icon } from '../assets/icons';
import { useAuth } from '../context/AuthContext';
import { useMockToast } from '../components/ui/MockToast';
import { usernameFromEmail } from '../lib/supabaseData';
import { supabase } from '../lib/supabase';
import { validateEmailField } from '../utils/validators';
import './AccountManagementPage.css';

type DestructiveAction = 'deactivate' | 'delete';

function ConfirmationDialog({
  action,
  backendMode,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  action: DestructiveAction;
  backendMode: 'supabase' | 'mock';
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const isDelete = action === 'delete';
  const title = isDelete ? 'Request account deletion?' : 'Deactivate your account?';

  return (
    <div className="account-dialog-backdrop" role="presentation">
      <section className="account-dialog ag-liquid-glass-strong" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title">
        <div className="account-dialog-icon">
          <Icon name="alert" />
        </div>
        <h2 id="account-dialog-title">{title}</h2>
        <p>
          {isDelete
            ? 'This submits a private deletion request for review. It does not immediately delete your account or data; protected writes and uploads are blocked while the request is pending.'
            : 'Deactivation blocks account access while preserving your profile, artwork, commission history, and financial records. Contact support to request reactivation.'}
        </p>
        <p className="account-dialog-limit">
          {backendMode === 'supabase'
            ? 'Active commissions, pending payments, open commission posts, and pending applications must be resolved first.'
            : 'Account actions are unavailable in demo mode. No changes will be made.'}
        </p>
        {isDelete && (
          <label className="field-label" htmlFor="confirm-delete">
            Type DELETE to confirm this request
            <input
              id="confirm-delete"
              className="account-dialog-input"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoFocus
            />
          </label>
        )}
        {error && <p className="account-action-error" role="alert">{error}</p>}
        <div className="account-dialog-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm account-danger-button"
            disabled={busy || (isDelete && typed !== 'DELETE')}
            onClick={onConfirm}
            aria-busy={busy}
          >
            {busy
              ? 'Submitting...'
              : isDelete ? 'Submit Deletion Request' : 'Confirm Deactivation'}
          </button>
        </div>
      </section>
    </div>
  );
}

export function AccountManagementPage() {
  const navigate = useNavigate();
  const { user, backendMode, changeEmail, deactivateAccount, requestAccountDeletion } = useAuth();
  const { toast, showToast } = useMockToast();
  const [email, setEmail] = useState(user?.email ?? '');
  const [emailError, setEmailError] = useState<string | undefined>();
  const [emailSuccess, setEmailSuccess] = useState<string | undefined>();
  const [savingEmail, setSavingEmail] = useState(false);
  const [dialogAction, setDialogAction] = useState<DestructiveAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [deletionRequest, setDeletionRequest] = useState<{ status: string; requested_at: string } | null>(null);
  const [deletionRequestLoadError, setDeletionRequestLoadError] = useState<string>();

  useEffect(() => {
    if (backendMode !== 'supabase' || !supabase || !user?.id) return undefined;
    let active = true;
    setDeletionRequestLoadError(undefined);
    void (async () => {
      try {
        const { data, error } = await supabase
          .from('account_deletion_requests')
          .select('status, requested_at')
          .order('requested_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!active) return;
        if (error) {
          setDeletionRequestLoadError(error.message);
          return;
        }
        setDeletionRequest(data);
      } catch (error) {
        if (!active) return;
        setDeletionRequestLoadError(error instanceof Error ? error.message : 'Unable to load deletion request status.');
      }
    })();

    return () => {
      active = false;
    };
  }, [backendMode, user?.id]);

  const roleLabel = user?.role === 'artist' ? 'Artist' : user?.role === 'client' ? 'Client' : '—';
  const username = user?.username || usernameFromEmail(user?.email);
  const createdLabel = user?.createdAt
    ? new Date(user.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : 'Not available';

  const handleEmailSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const validation = validateEmailField(email);
    setEmailError(validation);
    setEmailSuccess(undefined);
    if (validation) return;
    if (email.trim().toLowerCase() === user?.email.toLowerCase()) {
      setEmailError('Enter a different email address.');
      return;
    }

    setSavingEmail(true);
    const result = await changeEmail(email);
    setSavingEmail(false);
    if (!result.success) {
      setEmailError(result.error ?? 'Could not change your email address.');
      return;
    }
    setEmailSuccess(backendMode === 'supabase'
      ? 'A confirmation link was sent to your new email address. Your current email stays active until you confirm it.'
      : 'Your email address was updated.');
    if (backendMode === 'mock') showToast('Email updated');
  };

  const confirmAccountAction = async () => {
    if (!dialogAction || actionBusy) return;
    const action = dialogAction;
    setActionBusy(true);
    setActionError(undefined);
    let succeeded: boolean;
    let errorMessage: string | undefined;
    let warning: string | undefined;
    if (action === 'deactivate') {
      const result = await deactivateAccount();
      succeeded = result.success;
      errorMessage = result.error;
      warning = result.warning;
    } else {
      const result = await requestAccountDeletion();
      succeeded = result.success;
      errorMessage = result.error;
    }
    setActionBusy(false);

    if (!succeeded) {
      setActionError(errorMessage ?? 'The account action could not be completed.');
      return;
    }

    setDialogAction(null);
    if (action === 'delete') {
      setDeletionRequest({ status: 'PENDING', requested_at: new Date().toISOString() });
      showToast('Deletion request submitted for review. Your account and data have not been erased.');
      return;
    }

    showToast(warning ?? 'Your account is deactivated and you have been signed out.');
    navigate('/login', { replace: true });
  };

  const deletionStatusMessage = deletionRequest?.status === 'PENDING'
    ? 'Awaiting review. Your data remains intact, but protected account changes and uploads are blocked. Nothing has been permanently deleted.'
    : deletionRequest?.status === 'APPROVED'
      ? 'Approved and awaiting authorized processing. Your data has not been erased yet.'
      : deletionRequest?.status === 'REJECTED'
        ? 'The request was declined. Contact support if you need more information.'
        : deletionRequest?.status === 'COMPLETED'
          ? 'The request was marked complete by an authorized reviewer.'
          : deletionRequest?.status === 'CANCELLED'
            ? 'The request was cancelled.'
            : undefined;

  return (
    <ScreenShell
      header={
        <div className="px-hd row-between">
          <div className="row gap-10">
            <IconButton icon="chevron-l" onClick={() => navigate('/profile/settings')} ariaLabel="Back to Settings" />
            <span className="h-title" style={{ fontSize: 19 }}>
              Account
            </span>
          </div>
        </div>
      }
    >
      <div className="row-between" style={{ marginBottom: 10 }}>
        <span className="section-title">Profile</span>
      </div>
      <div className="card" style={{ marginBottom: 20, padding: 0, overflow: 'hidden' }}>
        <SettingsRow
          icon="user"
          label="Edit Profile"
          sublabel="Name, username, bio, photo & interests"
          onClick={() => navigate('/profile/edit')}
        />
      </div>

      <div className="row-between" style={{ marginBottom: 10 }}>
        <span className="section-title">Account Info</span>
      </div>
      <div className="card" style={{ marginBottom: 20, padding: 0, overflow: 'hidden' }}>
        <SettingsRow icon="mail" label="Email" sublabel={user?.email ?? '—'} />
        <hr className="soft" style={{ margin: 0 }} />
        <SettingsRow icon="user" label="Username" sublabel={`@${username}`} />
        <hr className="soft" style={{ margin: 0 }} />
        <SettingsRow icon="shield" label="Account type" sublabel={roleLabel} />
        <hr className="soft" style={{ margin: 0 }} />
        <SettingsRow icon="calendar" label="Created" sublabel={createdLabel} />
      </div>

      <div className="row-between" style={{ marginBottom: 10 }}>
        <span className="section-title">Change Email</span>
      </div>
      <form className="card account-email-card" onSubmit={handleEmailSubmit} noValidate>
        <label className="field-label" htmlFor="account-email">
          New email address
        </label>
        <div className={`input-field${emailError ? ' is-error' : ''}`}>
          <Icon name="mail" style={{ width: 16, height: 16, stroke: 'var(--ag-text-low)' }} />
          <input
            id="account-email"
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              if (emailError) setEmailError(undefined);
              if (emailSuccess) setEmailSuccess(undefined);
            }}
            autoComplete="email"
          />
        </div>
        {emailError && <div className="field-error" role="alert">{emailError}</div>}
        {emailSuccess && <div className="account-success" role="status">{emailSuccess}</div>}
        <AuthButton type="submit" loading={savingEmail} style={{ marginTop: 14 }}>
          Update Email
        </AuthButton>
      </form>

      <div className="row-between" style={{ margin: '20px 0 10px' }}>
        <span className="section-title">Danger Zone</span>
      </div>
      <div className="card account-danger-card" style={{ marginBottom: 14, padding: 0, overflow: 'hidden' }}>
        <SettingsRow
          icon="lock"
          label="Deactivate Account"
          sublabel="Temporarily disable account access"
          onClick={() => setDialogAction('deactivate')}
        />
        <hr className="soft" style={{ margin: 0 }} />
        <SettingsRow
          icon="alert"
          label="Delete Account"
          sublabel="Request deletion review — data is not immediately erased"
          onClick={() => setDialogAction('delete')}
        />
      </div>
      {deletionRequestLoadError && (
        <div className="account-action-error" role="alert">
          Could not load deletion request status: {deletionRequestLoadError}
        </div>
      )}
      {deletionRequest && deletionStatusMessage && (
        <div className="account-deletion-status" role="status" aria-live="polite">
          <strong>Deletion request: {deletionRequest.status.toLowerCase()}</strong>
          <span>{deletionStatusMessage}</span>
        </div>
      )}
      {toast}
      {dialogAction && (
        <ConfirmationDialog
          action={dialogAction}
          backendMode={backendMode}
          busy={actionBusy}
          error={actionError}
          onCancel={() => {
            if (actionBusy) return;
            setDialogAction(null);
            setActionError(undefined);
          }}
          onConfirm={() => void confirmAccountAction()}
        />
      )}
    </ScreenShell>
  );
}
