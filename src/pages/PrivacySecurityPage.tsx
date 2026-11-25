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

function getPasswordUpdateError(code: string | undefined, message: string): string {
  const normalizedMessage = message.toLowerCase();
  if (code === 'reauthentication_not_valid' || code === 'otp_expired') {
    return 'That verification code is invalid or expired. Check the code or request a new one.';
  }
  if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit') {
    return 'Too many verification attempts. Wait a little while before trying again.';
  }
  if (code === 'weak_password') {
    return 'Supabase rejected this password. Choose a password that meets your project’s password requirements.';
  }
  if (
    code === 'current_password_required'
    || normalizedMessage.includes('current password is required')
    || normalizedMessage.includes('requires current password')
  ) {
    return 'This project requires the current password to change credentials. This Google-only account has no current password to provide; contact your administrator for the supported recovery path.';
  }
  if (code === 'reauthentication_needed') {
    return 'Recent verification is required. Try again to request a verification code.';
  }
  return 'Could not update the password. Please try again.';
}

/**
 * Privacy & Security settings.
 *
 * Only surfaces controls that are actually backed by something real:
 *  - Password actions use Supabase Auth identities; existing email sign-in
 *    accounts reuse the current password-reset flow.
 *  - "Where your data lives" reads the app's real `backendMode` so it
 *    never claims data is synced when it's only stored locally, or
 *    vice versa.
 * Things like profile-visibility or blocked-account controls aren't
 * wired to anything in the backend yet, so they're left out rather
 * than shown as working toggles.
 */
export function PrivacySecurityPage() {
  const navigate = useNavigate();
  const { user, backendMode, requestPasswordReset } = useAuth();
  const { toast, showToast } = useMockToast();
  const [sendingReset, setSendingReset] = useState(false);
  const [resetError, setResetError] = useState<string>();
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

  const handleChangePassword = async () => {
    if (signInMethods.status !== 'ready' || !signInMethods.email || sendingReset) return;
    setResetError(undefined);
    setSendingReset(true);
    try {
      const result = await requestPasswordReset(signInMethods.email);
      if (result.success) {
        showToast(`Password reset email requested for ${signInMethods.email}. Check your inbox and spam folder.`);
      } else {
        setResetError(result.error ?? 'Could not send a password reset link. Please try again.');
      }
    } catch {
      setResetError('Could not send a password reset link. Please try again.');
    } finally {
      setSendingReset(false);
    }
  };

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
    if (signInMethods.hasEmailPassword) {
      void handleChangePassword();
      return;
    }
    if (!signInMethods.providers.includes('google')) {
      setResetError('Could not verify a supported sign-in method for this account.');
      return;
    }
    setResetError(undefined);
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
        setPasswordError(getPasswordUpdateError(error.code, error.message));
        return false;
      }
      setReauthRequired(true);
      setReauthMessage(`A verification code was sent to ${signInMethods.status === 'ready' ? signInMethods.email : 'your registered email'}.`);
      setPasswordError(undefined);
      return true;
    } catch {
      setPasswordError('Could not send a verification code. Please try again.');
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
          setPasswordError(getPasswordUpdateError(error.code, error.message));
        }
        return;
      }
      if (!data.user || data.user.id !== user?.id) {
        setPasswordError('The password update could not be verified for this account. Please refresh and check sign-in methods.');
        return;
      }

      const providers = [...new Set([...signInMethods.providers, 'email'])].sort();
      setSignInMethods({
        status: 'ready',
        email: signInMethods.email,
        providers,
        hasEmailPassword: true,
      });
      setSetPasswordOpen(false);
      clearSetPasswordForm();
      showToast('Password successfully added. You can now sign in using your email and password on other devices.');
    } catch {
      setPasswordError('Could not update the password. Please try again.');
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
      <div className="card" style={{ marginBottom: 20, padding: 0, overflow: 'hidden' }}>
        <SettingsRow
          icon="lock"
          label={signInMethods.status === 'ready'
            ? signInMethods.hasEmailPassword ? 'Change Password' : 'Set Password'
            : signInMethods.status === 'loading' ? 'Checking sign-in methods…' : 'Password'}
          sublabel={sendingReset
            ? 'Sending reset link…'
            : signInMethods.status === 'ready'
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
      {resetError && <div className="t-xs c-danger" role="alert" style={{ marginBottom: 20 }}>{resetError}</div>}

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
            <h2 id="set-password-title">Set Your Password</h2>
            <p>Create a password so you can sign in with your email on any device, without needing Google sign-in.</p>
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
                  Set Password
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
