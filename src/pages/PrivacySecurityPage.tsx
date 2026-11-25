import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScreenShell } from '../components/ui/ScreenShell';
import { IconButton } from '../components/ui/IconButton';
import { SettingsRow } from './SettingsPage';
import { useAuth } from '../context/AuthContext';
import { useMockToast } from '../components/ui/MockToast';
import { AuthInput } from '../components/auth/AuthInput';
import { AuthButton } from '../components/auth/AuthButton';
import { Icon } from '../assets/icons';
import { assessPassword, validateConfirmPassword } from '../utils/validators';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import './PrivacySecurityPage.css';

type AccountSignInMethods =
  | { status: 'loading' | 'unknown' | 'unavailable' }
  | { status: 'ready'; email: string; providers: string[]; hasEmailPassword: boolean };

function sameProviders(left: string[], right: string[]): boolean {
  const leftSet = new Set(left.map((provider) => provider.toLowerCase()));
  const rightSet = new Set(right.map((provider) => provider.toLowerCase()));
  return leftSet.size === rightSet.size && [...leftSet].every((provider) => rightSet.has(provider));
}

function formatProviderName(provider: string): string {
  if (provider === 'google') return 'Google';
  if (provider === 'email') return 'Email & Password';
  return provider.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getPasswordUpdateError(error: unknown, operation: 'update' | 'reauthenticate'): string {
  const errorName = error instanceof Error ? error.name : '';
  const errorMessage = error instanceof Error ? error.message.toLowerCase() : '';
  const errorCode = error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
  const errorStatus = error instanceof Error && 'status' in error && typeof error.status === 'number'
    ? error.status
    : undefined;

  if (errorCode === 'reauthentication_not_valid' || errorCode === 'otp_expired') {
    return 'That verification code is invalid or expired. Check the code or request a new one.';
  }
  if (errorCode === 'session_not_found'
    || errorCode === 'session_expired'
    || errorCode === 'refresh_token_not_found'
    || errorCode === 'invalid_grant'
    || errorName === 'AuthSessionMissingError'
    || errorMessage.includes('session has expired')) {
    return 'Your session has expired. Sign in again, then retry the password update.';
  }
  if (errorCode === 'over_email_send_rate_limit' || errorCode === 'over_request_rate_limit') {
    return operation === 'reauthenticate'
      ? 'Supabase is rate-limiting verification emails. Wait before requesting another code.'
      : 'Too many password update attempts. Wait a little while before trying again.';
  }
  if (operation === 'update'
    && (errorCode === 'weak_password' || errorCode === 'validation_failed' || errorStatus === 422)) {
    return 'Supabase rejected this password. Choose a password that meets your project’s password requirements.';
  }
  if (operation === 'update' && (
    errorCode === 'current_password_required'
    || errorMessage.includes('current password is required')
    || errorMessage.includes('requires current password')
  )) {
    return 'Supabase requires the current password for this update. This form cannot bypass that requirement.';
  }
  if (operation === 'update' && errorCode === 'same_password') {
    return 'Choose a password that is different from your current password.';
  }
  if (
    errorName === 'AuthRetryableFetchError'
    || errorName === 'TypeError'
    || errorStatus === 0
    || (errorStatus !== undefined && errorStatus >= 500)
  ) {
    return operation === 'reauthenticate'
      ? 'Could not connect to Supabase to send a verification code. Check your connection and try again.'
      : 'Could not connect to Supabase to update your password. Check your connection and try again.';
  }
  if (operation === 'reauthenticate') {
    return 'Supabase could not send the verification code. Please try again later.';
  }
  return 'Could not update the password. Please try again.';
}

/**
 * Privacy & Security settings.
 *
 * Only surfaces controls that are actually backed by something real:
 *  - Password actions use the authenticated Supabase Auth session.
 *  - "Where your data lives" reads the app's real `backendMode` so it
 *    never claims data is synced when it's only stored locally, or
 *    vice versa.
 * Things like profile-visibility or blocked-account controls aren't
 * wired to anything in the backend yet, so they're left out rather
 * than shown as working toggles.
 */
export function PrivacySecurityPage() {
  const navigate = useNavigate();
  const { user, backendMode } = useAuth();
  const { toast, showToast } = useMockToast();
  const [securityError, setSecurityError] = useState<string>();
  const [identityRefresh, setIdentityRefresh] = useState(0);
  const [signInMethods, setSignInMethods] = useState<AccountSignInMethods>({ status: 'loading' });
  const [setPasswordOpen, setSetPasswordOpen] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [reauthCode, setReauthCode] = useState('');
  const [reauthRequired, setReauthRequired] = useState(false);
  const [reauthMessage, setReauthMessage] = useState<string>();
  const [passwordError, setPasswordError] = useState<string>();
  const [savingPassword, setSavingPassword] = useState(false);
  const [sendingReauthCode, setSendingReauthCode] = useState(false);
  const [passwordStrength, setPasswordStrength] = useState(() => assessPassword(''));

  useEffect(() => {
    let active = true;
    if (backendMode !== 'supabase' || !isSupabaseConfigured || !supabase || !user?.id) {
      setSignInMethods({ status: 'unavailable' });
      return () => { active = false; };
    }

    setSignInMethods({ status: 'loading' });
    void (async () => {
      try {
        const [
          { data: { user: verifiedUser }, error: userError },
          { data: identityData, error: identitiesError },
        ] = await Promise.all([
          supabase.auth.getUser(),
          supabase.auth.getUserIdentities(),
        ]);
        if (userError || identitiesError || !verifiedUser || verifiedUser.id !== user.id) {
          if (active) setSignInMethods({ status: 'unknown' });
          return;
        }

        const identities = identityData.identities;
        const providers = [...new Set(identities.map((identity) => identity.provider.toLowerCase()))].sort();
        const metadataProviders = verifiedUser.app_metadata?.providers;
        if (
          !verifiedUser.email
          || identities.length === 0
          || !identities.every((identity) => identity.user_id === verifiedUser.id)
          || providers.length === 0
          || (Array.isArray(metadataProviders) && !sameProviders(providers, metadataProviders))
        ) {
          if (active) setSignInMethods({ status: 'unknown' });
          return;
        }

        if (active) {
          setSignInMethods({
            status: 'ready',
            email: verifiedUser.email,
            providers,
            hasEmailPassword: providers.includes('email'),
          });
        }
      } catch {
        if (active) setSignInMethods({ status: 'unknown' });
      }
    })();

    return () => { active = false; };
  }, [backendMode, identityRefresh, user?.id]);

  const clearSetPasswordForm = () => {
    setNewPassword('');
    setConfirmNewPassword('');
    setReauthCode('');
    setReauthRequired(false);
    setReauthMessage(undefined);
    setPasswordError(undefined);
    setPasswordStrength(assessPassword(''));
    setSendingReauthCode(false);
  };

  const closeSetPasswordDialog = () => {
    if (savingPassword || sendingReauthCode) return;
    setSetPasswordOpen(false);
    clearSetPasswordForm();
  };

  const openPasswordAction = () => {
    if (signInMethods.status === 'unknown') {
      setIdentityRefresh((current) => current + 1);
      return;
    }
    if (signInMethods.status !== 'ready') return;
    if (!signInMethods.hasEmailPassword && !signInMethods.providers.includes('google')) {
      setSecurityError('Could not verify a supported sign-in method for this account.');
      return;
    }
    setSecurityError(undefined);
    clearSetPasswordForm();
    setSetPasswordOpen(true);
  };

  const requestPasswordReauthentication = async () => {
    if (sendingReauthCode) return false;
    if (!supabase) {
      setPasswordError('Supabase is not available. Please sign in again and retry.');
      return false;
    }
    setSendingReauthCode(true);
    try {
      const { error } = await supabase.auth.reauthenticate();
      if (error) {
        setPasswordError(getPasswordUpdateError(error, 'reauthenticate'));
        return false;
      }
      setReauthRequired(true);
      setReauthMessage('Enter the verification code sent to your verified contact method to authorize this password update.');
      setPasswordError(undefined);
      return true;
    } catch (error) {
      setPasswordError(getPasswordUpdateError(error, 'reauthenticate'));
      return false;
    } finally {
      setSendingReauthCode(false);
    }
  };

  const handleSetPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingPassword || signInMethods.status !== 'ready' || !supabase) return;
    setPasswordError(undefined);
    if (!newPassword) {
      setPasswordError('Enter a new password.');
      return;
    }
    const confirmationError = validateConfirmPassword(newPassword, confirmNewPassword);
    if (confirmationError) {
      setPasswordError(confirmationError);
      return;
    }
    if (reauthRequired && !reauthCode.trim()) {
      setPasswordError('Enter the verification code sent to your email.');
      return;
    }

    setSavingPassword(true);
    try {
      const { data, error } = await supabase.auth.updateUser({
        password: newPassword,
        ...(reauthRequired ? { nonce: reauthCode.trim() } : {}),
      });
      if (error) {
        if (error.code === 'reauthentication_needed' && !reauthRequired) {
          await requestPasswordReauthentication();
        } else {
          setPasswordError(getPasswordUpdateError(error, 'update'));
        }
        return;
      }
      if (!data.user || data.user.id !== user?.id) {
        setPasswordError('The password update could not be verified for this account. Please refresh and check sign-in methods.');
        return;
      }

      setSetPasswordOpen(false);
      clearSetPasswordForm();
      setSignInMethods({ status: 'loading' });
      setIdentityRefresh((current) => current + 1);
      showToast(signInMethods.hasEmailPassword
        ? 'Password updated successfully.'
        : 'Password successfully added. You can now sign in using your email and password.');
    } catch (error) {
      setPasswordError(getPasswordUpdateError(error, 'update'));
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <ScreenShell
      header={
        <div className="px-hd row-between">
          <div className="row gap-10">
            <IconButton icon="chevron-l" onClick={() => navigate('/profile/settings')} ariaLabel="Back to Settings" />
            <span className="h-title" style={{ fontSize: 19 }}>
              Privacy &amp; Security
            </span>
          </div>
        </div>
      }
    >
      <div className="row-between" style={{ marginBottom: 10 }}>
        <span className="section-title">Account Security</span>
      </div>
      <div className="card privacy-security-account-card" style={{ marginBottom: 20, padding: 0, overflow: 'hidden' }}>
        <SettingsRow
          icon="lock"
          label={signInMethods.status === 'ready'
            ? signInMethods.hasEmailPassword ? 'Change Password' : 'Set Password'
            : signInMethods.status === 'loading' ? 'Checking sign-in methods…' : 'Password'}
          sublabel={signInMethods.status === 'ready'
              ? signInMethods.hasEmailPassword
                ? 'Update your email sign-in password'
                : 'Add email and password sign-in for your account'
              : signInMethods.status === 'unavailable'
                ? 'Password settings require an authenticated Supabase account'
                : 'Could not verify sign-in methods. Tap to retry.'}
          onClick={signInMethods.status === 'ready' || signInMethods.status === 'unknown' ? openPasswordAction : undefined}
        />
        {signInMethods.status === 'ready' && (
          <div className="privacy-security-sign-in-methods">
            Sign-in methods: {signInMethods.providers.map(formatProviderName).join(' · ')}
          </div>
        )}
      </div>
      {securityError && <div className="t-xs c-danger" role="alert" style={{ marginBottom: 20 }}>{securityError}</div>}

      <div className="row-between" style={{ marginBottom: 10 }}>
        <span className="section-title">Data</span>
      </div>
      <div className="card" style={{ marginBottom: 14, padding: 0, overflow: 'hidden' }}>
        <SettingsRow
          icon="shield"
          label="Where your data lives"
          sublabel={
            backendMode === 'supabase'
              ? 'Synced to your Supabase project'
              : 'Stored locally on this device only (mock mode)'
          }
        />
      </div>

      <p className="t-xs c-low" style={{ lineHeight: 1.6, padding: '0 4px' }}>
        Profile visibility and blocked-account controls aren&apos;t available yet — this section will grow as those
        features ship.
      </p>
      {setPasswordOpen && signInMethods.status === 'ready' && (
        <div className="account-dialog-backdrop" role="presentation" onClick={closeSetPasswordDialog}>
          <section
            className="account-dialog privacy-set-password-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="set-password-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="set-password-title">{signInMethods.hasEmailPassword ? 'Change Your Password' : 'Set Your Password'}</h2>
            <p>{signInMethods.hasEmailPassword
              ? 'Enter a new password for your email sign-in.'
              : 'Create a password so you can sign in with your email on any device, without needing Google sign-in.'}</p>
            <div className="privacy-set-password-email">
              <span className="t-xs c-low">Account email</span>
              <strong>{signInMethods.email}</strong>
            </div>
            <form onSubmit={handleSetPassword} noValidate>
              <AuthInput
                label="New Password"
                icon="lock"
                type="password"
                value={newPassword}
                onChange={(value) => {
                  setNewPassword(value);
                  setPasswordStrength(assessPassword(value));
                  setPasswordError(undefined);
                }}
                autoComplete="new-password"
                name="new-password"
                disabled={savingPassword || sendingReauthCode}
              />
              {newPassword && (
                <div className={`privacy-password-strength is-${passwordStrength.strength}`} aria-live="polite">
                  Password strength: {passwordStrength.strength}
                </div>
              )}
              <AuthInput
                label="Confirm New Password"
                icon="lock"
                type="password"
                value={confirmNewPassword}
                onChange={(value) => {
                  setConfirmNewPassword(value);
                  setPasswordError(undefined);
                }}
                autoComplete="new-password"
                name="confirm-new-password"
                disabled={savingPassword || sendingReauthCode}
              />
              {reauthRequired && (
                <>
                  <div className="privacy-password-reauth-note" role="status">{reauthMessage}</div>
                  <AuthInput
                    label="Verification code"
                    icon="lock"
                    value={reauthCode}
                    onChange={(value) => {
                      setReauthCode(value);
                      setPasswordError(undefined);
                    }}
                    autoComplete="one-time-code"
                    name="reauthentication-code"
                    disabled={savingPassword}
                  />
                  <button
                    type="button"
                    className="auth-link-btn t-xs"
                    onClick={() => void requestPasswordReauthentication()}
                    disabled={savingPassword || sendingReauthCode}
                  >
                    {sendingReauthCode ? 'Sending verification code…' : 'Send a new verification code'}
                  </button>
                </>
              )}
              {passwordError && (
                <div className="auth-banner error privacy-set-password-error" role="alert">
                  <Icon name="alert" style={{ stroke: 'var(--ag-danger)' }} />
                  <span>{passwordError}</span>
                </div>
              )}
              <div className="account-dialog-actions">
                <AuthButton
                  variant="ghost"
                  onClick={closeSetPasswordDialog}
                  disabled={savingPassword || sendingReauthCode}
                >
                  Cancel
                </AuthButton>
                <AuthButton
                  type="submit"
                  loading={savingPassword}
                  disabled={savingPassword || sendingReauthCode}
                >
                  {signInMethods.hasEmailPassword ? 'Change Password' : 'Set Password'}
                </AuthButton>
              </div>
            </form>
          </section>
        </div>
      )}
      {toast}
    </ScreenShell>
  );
}
