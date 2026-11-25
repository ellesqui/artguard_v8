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
import { validateConfirmPassword } from '../utils/validators';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import './PrivacySecurityPage.css';

type AccountSignInMethods =
  | { status: 'loading' | 'unknown' | 'unavailable' }
  | { status: 'ready'; email: string; providers: string[]; hasEmailPassword: boolean };

type PasswordDialogMode = 'set' | 'choose' | 'current' | 'reset' | 'reset-sent';
type PasswordChangeMethod = 'current' | 'reset';
type PasswordOperation = 'update' | 'reauthenticate' | 'verify-current' | 'reset-email';

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

function getPasswordFlowError(error: unknown, operation: PasswordOperation): string {
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
  if (operation === 'verify-current'
    && (errorCode === 'invalid_credentials' || errorStatus === 401)) {
    return 'The current password is incorrect.';
  }
  if (operation === 'verify-current' && errorCode === 'email_not_confirmed') {
    return 'Verify your account email before using it to confirm the current password.';
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
    if (operation === 'reauthenticate') {
      return 'Supabase is rate-limiting verification messages. Wait before requesting another code.';
    }
    if (operation === 'reset-email') {
      return 'Too many password reset requests. Wait before requesting another email.';
    }
    return operation === 'verify-current'
      ? 'Too many sign-in attempts. Wait a little while before trying again.'
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
  if (operation === 'update' && errorCode === 'reauthentication_needed') {
    return 'Supabase requires recent verification. Request a new code and try again.';
  }
  if (operation === 'reset-email' && errorMessage.includes('redirect')) {
    return 'Supabase rejected the recovery redirect. Add this app’s /reset-password URL to the allowed redirect URLs.';
  }
  if (
    errorName === 'AuthRetryableFetchError'
    || errorName === 'TypeError'
    || errorStatus === 0
    || (errorStatus !== undefined && errorStatus >= 500)
  ) {
    if (operation === 'reauthenticate') {
      return 'Could not connect to Supabase to send a verification code. Check your connection and try again.';
    }
    if (operation === 'reset-email') {
      return 'Could not connect to Supabase to submit the reset request. Check your connection and try again.';
    }
    return operation === 'verify-current'
      ? 'Could not connect to Supabase to verify the current password. Check your connection and try again.'
      : 'Could not connect to Supabase to update your password. Check your connection and try again.';
  }
  if (operation === 'reauthenticate') {
    return 'Supabase could not send the verification code. Please try again later.';
  }
  if (operation === 'reset-email') {
    return 'Supabase could not accept the reset request. Verify Auth email delivery and the allowed redirect URL configuration.';
  }
  if (operation === 'verify-current') {
    return 'Could not verify the current password. Please try again.';
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
  const [passwordDialogMode, setPasswordDialogMode] = useState<PasswordDialogMode>('set');
  const [selectedPasswordMethod, setSelectedPasswordMethod] = useState<PasswordChangeMethod>();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [reauthCode, setReauthCode] = useState('');
  const [reauthRequired, setReauthRequired] = useState(false);
  const [reauthMessage, setReauthMessage] = useState<string>();
  const [passwordError, setPasswordError] = useState<string>();
  const [savingPassword, setSavingPassword] = useState(false);
  const [sendingReauthCode, setSendingReauthCode] = useState(false);
  const [requestingReset, setRequestingReset] = useState(false);
  const [resetRequestError, setResetRequestError] = useState<string>();

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
    setCurrentPassword('');
    setNewPassword('');
    setConfirmNewPassword('');
    setReauthCode('');
    setReauthRequired(false);
    setReauthMessage(undefined);
    setPasswordError(undefined);
    setSendingReauthCode(false);
    setResetRequestError(undefined);
  };

  const closeSetPasswordDialog = () => {
    if (savingPassword || sendingReauthCode || requestingReset) return;
    setSetPasswordOpen(false);
    clearSetPasswordForm();
    setSelectedPasswordMethod(undefined);
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
    setSelectedPasswordMethod(undefined);
    setPasswordDialogMode(signInMethods.hasEmailPassword ? 'choose' : 'set');
    setSetPasswordOpen(true);
  };

  const backToPasswordOptions = () => {
    if (savingPassword || sendingReauthCode || requestingReset) return;
    clearSetPasswordForm();
    setSelectedPasswordMethod(undefined);
    setPasswordDialogMode('choose');
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
        setPasswordError(getPasswordFlowError(error, 'reauthenticate'));
        return false;
      }
      setReauthRequired(true);
      setReauthMessage('Enter the verification code sent to your verified contact method to authorize this password update.');
      setPasswordError(undefined);
      return true;
    } catch (error) {
      setPasswordError(getPasswordFlowError(error, 'reauthenticate'));
      return false;
    } finally {
      setSendingReauthCode(false);
    }
  };

  const verifyCurrentPassword = async (): Promise<boolean> => {
    if (!supabase || signInMethods.status !== 'ready' || !user?.id) return false;
    try {
      const [
        { data: { session }, error: sessionError },
        { data: { user: verifiedUser }, error: userError },
      ] = await Promise.all([
        supabase.auth.getSession(),
        supabase.auth.getUser(),
      ]);
      if (
        sessionError
        || userError
        || !session
        || !verifiedUser
        || session.user.id !== user.id
        || verifiedUser.id !== user.id
        || !verifiedUser.email
        || verifiedUser.email.toLowerCase() !== signInMethods.email.toLowerCase()
      ) {
        setPasswordError('Your account session could not be verified. Sign in again and retry.');
        return false;
      }

      const { data, error } = await supabase.auth.signInWithPassword({
        email: verifiedUser.email,
        password: currentPassword,
      });
      if (error) {
        if (error.code === 'invalid_credentials') setCurrentPassword('');
        setPasswordError(getPasswordFlowError(error, 'verify-current'));
        return false;
      }
      if (!data.session || !data.user || data.user.id !== verifiedUser.id) {
        if (data.session) {
          const { error: restoreError } = await supabase.auth.setSession({
            access_token: session.access_token,
            refresh_token: session.refresh_token,
          });
          if (restoreError) {
            setPasswordError('The account verification returned a different user and the original session could not be restored. Sign in again before continuing.');
            return false;
          }
        }
        setPasswordError('The current password did not verify for the signed-in account. The original session remains active.');
        return false;
      }
      return true;
    } catch (error) {
      setPasswordError(getPasswordFlowError(error, 'verify-current'));
      return false;
    }
  };

  const handlePasswordSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      savingPassword
      || signInMethods.status !== 'ready'
      || !supabase
      || (passwordDialogMode !== 'set' && passwordDialogMode !== 'current')
    ) return;
    setPasswordError(undefined);
    if (passwordDialogMode === 'current' && !currentPassword) {
      setPasswordError('Enter your current password.');
      return;
    }
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
      setPasswordError('Enter the verification code sent to your verified contact method.');
      return;
    }

    setSavingPassword(true);
    try {
      if (passwordDialogMode === 'current' && !(await verifyCurrentPassword())) return;
      const { data, error } = await supabase.auth.updateUser({
        password: newPassword,
        ...(reauthRequired ? { nonce: reauthCode.trim() } : {}),
      });
      if (error) {
        if (error.code === 'reauthentication_needed' && !reauthRequired) {
          await requestPasswordReauthentication();
        } else {
          setPasswordError(getPasswordFlowError(error, 'update'));
        }
        return;
      }
      if (!data.user || data.user.id !== user?.id) {
        setPasswordError('The password update could not be verified for this account. Please refresh and check sign-in methods.');
        return;
      }

      const hadPassword = signInMethods.hasEmailPassword;
      setSetPasswordOpen(false);
      clearSetPasswordForm();
      setSelectedPasswordMethod(undefined);
      setSignInMethods({ status: 'loading' });
      setIdentityRefresh((current) => current + 1);
      showToast(hadPassword
        ? 'Password successfully updated.'
        : 'Password successfully added. You can now sign in using your email and password.');
    } catch (error) {
      setPasswordError(getPasswordFlowError(error, 'update'));
    } finally {
      setSavingPassword(false);
    }
  };

  const handleResetThroughEmail = async () => {
    if (requestingReset || signInMethods.status !== 'ready' || !supabase || !user?.id) return;
    setRequestingReset(true);
    setResetRequestError(undefined);
    try {
      const { data: { user: verifiedUser }, error: userError } = await supabase.auth.getUser();
      if (userError || !verifiedUser || verifiedUser.id !== user.id || !verifiedUser.email) {
        setResetRequestError('Your account session could not be verified. Sign in again and retry.');
        return;
      }
      const { error } = await supabase.auth.resetPasswordForEmail(verifiedUser.email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) {
        setResetRequestError(getPasswordFlowError(error, 'reset-email'));
        return;
      }
      setPasswordDialogMode('reset-sent');
    } catch (error) {
      setResetRequestError(getPasswordFlowError(error, 'reset-email'));
    } finally {
      setRequestingReset(false);
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
            <h2 id="set-password-title">
              {signInMethods.hasEmailPassword ? 'Change Your Password' : 'Set Your Password'}
            </h2>

            {passwordDialogMode === 'choose' && (
              <>
                <p>Choose how you want to change your password.</p>
                <div className="privacy-password-method-options">
                  <button
                    type="button"
                    className="privacy-password-method-option"
                    aria-pressed={selectedPasswordMethod === 'current'}
                    onClick={() => setSelectedPasswordMethod('current')}
                  >
                    <strong>Use Current Password</strong>
                    <span>Verify your current password and create a new one.</span>
                  </button>
                  <button
                    type="button"
                    className="privacy-password-method-option"
                    aria-pressed={selectedPasswordMethod === 'reset'}
                    onClick={() => setSelectedPasswordMethod('reset')}
                  >
                    <strong>Reset Through Email</strong>
                    <span>We&apos;ll send a secure password reset link to your registered email address.</span>
                  </button>
                </div>
                <div className="account-dialog-actions">
                  <AuthButton variant="ghost" onClick={closeSetPasswordDialog}>Cancel</AuthButton>
                  <AuthButton
                    disabled={!selectedPasswordMethod}
                    onClick={() => {
                      if (selectedPasswordMethod) setPasswordDialogMode(selectedPasswordMethod);
                    }}
                  >
                    Continue
                  </AuthButton>
                </div>
              </>
            )}

            {(passwordDialogMode === 'set' || passwordDialogMode === 'current') && (
              <>
                <p>{passwordDialogMode === 'current'
                  ? 'Verify your current password and create a new one.'
                  : 'Create a password so you can sign in with your email on any device, without needing Google sign-in.'}</p>
                <form onSubmit={handlePasswordSubmit} noValidate>
                  {passwordDialogMode === 'current' && (
                    <AuthInput
                      label="Current Password"
                      icon="lock"
                      type="password"
                      value={currentPassword}
                      onChange={(value) => {
                        setCurrentPassword(value);
                        setPasswordError(undefined);
                      }}
                      autoComplete="current-password"
                      name="current-password"
                      disabled={savingPassword || sendingReauthCode}
                      required
                    />
                  )}
                  <AuthInput
                    label="New Password"
                    icon="lock"
                    type="password"
                    value={newPassword}
                    onChange={(value) => {
                      setNewPassword(value);
                      setPasswordError(undefined);
                    }}
                    autoComplete="new-password"
                    name="new-password"
                    disabled={savingPassword || sendingReauthCode}
                    required
                  />
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
                    required
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
                        required
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
                    {signInMethods.hasEmailPassword && (
                      <AuthButton
                        variant="ghost"
                        onClick={backToPasswordOptions}
                        disabled={savingPassword || sendingReauthCode}
                      >
                        Back
                      </AuthButton>
                    )}
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
                      {signInMethods.hasEmailPassword ? 'Update Password' : 'Set Password'}
                    </AuthButton>
                  </div>
                </form>
              </>
            )}

            {passwordDialogMode === 'reset' && (
              <>
                <p>We&apos;ll send a secure password reset link to your registered email address.</p>
                <div className="privacy-set-password-email">
                  <span className="t-xs c-low">Registered email</span>
                  <strong>{signInMethods.email}</strong>
                </div>
                {resetRequestError && (
                  <div className="auth-banner error privacy-set-password-error" role="alert">
                    <Icon name="alert" style={{ stroke: 'var(--ag-danger)' }} />
                    <span>{resetRequestError}</span>
                  </div>
                )}
                <div className="account-dialog-actions">
                  <AuthButton
                    variant="ghost"
                    onClick={backToPasswordOptions}
                    disabled={requestingReset}
                  >
                    Back
                  </AuthButton>
                  <AuthButton
                    variant="ghost"
                    onClick={closeSetPasswordDialog}
                    disabled={requestingReset}
                  >
                    Cancel
                  </AuthButton>
                  <AuthButton
                    loading={requestingReset}
                    disabled={requestingReset}
                    onClick={() => void handleResetThroughEmail()}
                  >
                    Confirm and Send Reset Link
                  </AuthButton>
                </div>
              </>
            )}

            {passwordDialogMode === 'reset-sent' && (
              <>
                <div className="auth-banner success" role="status">
                  <Icon name="check-circle" style={{ stroke: 'var(--ag-success)' }} />
                  <span>
                    The reset request was accepted. Email delivery is not confirmed here; if delivery is enabled,
                    check your inbox and spam folder.
                  </span>
                </div>
                <div className="privacy-set-password-email">
                  <span className="t-xs c-low">Registered email</span>
                  <strong>{signInMethods.email}</strong>
                </div>
                <div className="account-dialog-actions">
                  <AuthButton variant="ghost" onClick={backToPasswordOptions}>Back</AuthButton>
                  <AuthButton variant="ghost" onClick={closeSetPasswordDialog}>Cancel</AuthButton>
                </div>
              </>
            )}
          </section>
        </div>
      )}
      {toast}
    </ScreenShell>
  );
}
