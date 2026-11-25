import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthShell } from '../components/auth/AuthShell';
import { AuthInput } from '../components/auth/AuthInput';
import { AuthButton } from '../components/auth/AuthButton';
import { Icon } from '../assets/icons';
import { useAuth } from '../context/AuthContext';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import { validateConfirmPassword, validateRequired } from '../utils/validators';

type RecoveryState = 'checking' | 'ready' | 'invalid' | 'success';
type RecoveryOperation = 'update' | 'reauthenticate';
const PASSWORD_ENABLED_MARKER = 'artguard_password_enabled';

function getRecoveryError(error: unknown, operation: RecoveryOperation = 'update'): string {
  const errorName = error instanceof Error ? error.name : '';
  const errorMessage = error instanceof Error ? error.message.toLowerCase() : '';
  const errorCode = error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
  const errorStatus = error instanceof Error && 'status' in error && typeof error.status === 'number'
    ? error.status
    : undefined;

  if (errorCode === 'reauthentication_not_valid' || errorCode === 'otp_expired') {
    return 'That verification code is invalid or expired. Request a new code and try again.';
  }
  if (
    errorCode === 'session_not_found'
    || errorCode === 'session_expired'
    || errorCode === 'refresh_token_not_found'
    || errorName === 'AuthSessionMissingError'
    || errorMessage.includes('session has expired')
  ) {
    return 'Your password reset session has expired. Request a new reset link.';
  }
  if (errorCode === 'over_email_send_rate_limit' || errorCode === 'over_request_rate_limit') {
    return operation === 'reauthenticate'
      ? 'Supabase is rate-limiting verification messages. Wait before requesting another code.'
      : 'Too many password reset attempts. Wait a little while before trying again.';
  }
  if (operation === 'update'
    && (errorCode === 'weak_password' || errorCode === 'validation_failed' || errorStatus === 422)) {
    return 'Supabase rejected this password. Choose one that meets the project’s password requirements.';
  }
  if (errorName === 'AuthRetryableFetchError' || errorName === 'TypeError' || errorStatus === 0 || (errorStatus !== undefined && errorStatus >= 500)) {
    return operation === 'reauthenticate'
      ? 'Could not connect to Supabase to send a verification code. Check your connection and try again.'
      : 'Could not connect to Supabase to update your password. Check your connection and try again.';
  }
  if (operation === 'reauthenticate') {
    return 'Supabase could not send the verification code. Please try again later.';
  }
  if (errorCode === 'reauthentication_needed') {
    return 'Supabase requires recent verification. Request a new code and try again.';
  }
  return 'Could not update your password. Please try again or request a new reset link.';
}

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const { backendMode, initializing, passwordRecoverySession, clearPasswordRecoverySession } = useAuth();
  const [recoveryState, setRecoveryState] = useState<RecoveryState>('checking');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [confirmError, setConfirmError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [successMessage, setSuccessMessage] = useState('Password updated successfully. Returning you to sign in…');
  const [reauthRequired, setReauthRequired] = useState(false);
  const [reauthCode, setReauthCode] = useState('');
  const [reauthMessage, setReauthMessage] = useState<string>();
  const [sendingReauth, setSendingReauth] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const recoveryCompletedRef = useRef(false);

  useEffect(() => {
    if (initializing || recoveryCompletedRef.current) return;
    let active = true;
    setRecoveryState('checking');

    if (backendMode !== 'supabase' || !isSupabaseConfigured || !supabase || !passwordRecoverySession) {
      setRecoveryState('invalid');
      return () => { active = false; };
    }

    void (async () => {
      try {
        const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
        if (sessionError || !sessionData.session) {
          if (active) setRecoveryState('invalid');
          return;
        }
        const { data: userData, error: userError } = await supabase.auth.getUser();
        if (userError || !userData.user) {
          if (active) setRecoveryState('invalid');
          return;
        }
        if (active) setRecoveryState('ready');
      } catch {
        if (active) setRecoveryState('invalid');
      }
    })();

    return () => { active = false; };
  }, [backendMode, initializing, passwordRecoverySession]);

  useEffect(() => {
    if (recoveryState !== 'success') return;
    const redirectTimer = window.setTimeout(() => navigate('/login', { replace: true }), 3000);
    return () => window.clearTimeout(redirectTimer);
  }, [navigate, recoveryState]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingRef.current || recoveryState !== 'ready') return;

    const nextPasswordError = validateRequired(password, 'New password');
    const nextConfirmError = validateConfirmPassword(password, confirmPassword);
    setPasswordError(nextPasswordError);
    setConfirmError(nextConfirmError);
    setFormError(undefined);
    if (nextPasswordError || nextConfirmError) return;
    if (reauthRequired && !reauthCode.trim()) {
      setFormError('Enter the verification code sent to your verified contact method.');
      return;
    }
    if (!supabase || !isSupabaseConfigured || !passwordRecoverySession) {
      setRecoveryState('invalid');
      return;
    }

    savingRef.current = true;
    setSaving(true);
    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData.session) {
        setRecoveryState('invalid');
        return;
      }
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) {
        setRecoveryState('invalid');
        return;
      }
      const { data: updatedUserData, error } = await supabase.auth.updateUser({
        password,
        data: {
          ...userData.user.user_metadata,
          [PASSWORD_ENABLED_MARKER]: true,
        },
        ...(reauthRequired ? { nonce: reauthCode.trim() } : {}),
      });
      if (error) {
        if (error.code === 'reauthentication_needed' && !reauthRequired) {
          setSaving(false);
          setSendingReauth(true);
          try {
            const { error: reauthError } = await supabase.auth.reauthenticate();
            if (reauthError) {
              setFormError(getRecoveryError(reauthError, 'reauthenticate'));
            } else {
              setReauthRequired(true);
              setReauthMessage('Enter the verification code sent to your verified contact method to authorize this password update.');
              setFormError(undefined);
            }
          } catch (reauthError) {
            setFormError(getRecoveryError(reauthError, 'reauthenticate'));
          } finally {
            setSendingReauth(false);
          }
          return;
        }
        setFormError(getRecoveryError(error));
        return;
      }
      if (
        !updatedUserData.user
        || updatedUserData.user.id !== userData.user.id
        || updatedUserData.user.user_metadata?.[PASSWORD_ENABLED_MARKER] !== true
      ) {
        setFormError('The password update could not be verified for this account. Request a new reset link and try again.');
        return;
      }
      const { data: refreshedUserData, error: refreshError } = await supabase.auth.getUser();
      const currentUserRefreshed = !refreshError
        && refreshedUserData.user?.id === userData.user.id
        && refreshedUserData.user.user_metadata?.[PASSWORD_ENABLED_MARKER] === true;
      setSuccessMessage(currentUserRefreshed
        ? 'Password updated successfully. Returning you to sign in…'
        : 'Password updated successfully. Sign in again to continue.');
      recoveryCompletedRef.current = true;
      clearPasswordRecoverySession();
      setPassword('');
      setConfirmPassword('');
      setReauthCode('');
      setReauthRequired(false);
      setReauthMessage(undefined);
      setPasswordError(undefined);
      setConfirmError(undefined);
      setFormError(undefined);
      setRecoveryState('success');
    } catch (error) {
      setFormError(getRecoveryError(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <AuthShell
      brandHeader
      title="Reset Password"
      subtitle="Choose a new password for your account."
      markIcon="lock"
      onBack={() => navigate('/login')}
    >
      {recoveryState === 'checking' && (
        <div className="auth-banner" role="status">Verifying your recovery session...</div>
      )}

      {recoveryState === 'invalid' && (
        <>
          <div className="auth-banner error" role="alert">
            <Icon name="alert" style={{ stroke: 'var(--ag-danger)' }} />
            <span>This password reset link is invalid or expired. Request a new link and try again.</span>
          </div>
          <AuthButton onClick={() => navigate('/forgot-password')}>Request a New Link</AuthButton>
          <p className="t-xs c-low auth-footnote">
            <button type="button" className="auth-link-btn t-xs" onClick={() => navigate('/login')}>Back to Login</button>
          </p>
        </>
      )}

      {recoveryState === 'ready' && (
        <form onSubmit={handleSubmit} noValidate>
          {formError && (
            <div className="auth-banner error" role="alert">
              <Icon name="alert" style={{ stroke: 'var(--ag-danger)' }} />
              <span>{formError}</span>
            </div>
          )}
          <AuthInput
            label="New Password"
            icon="lock"
            type="password"
            value={password}
            onChange={(value) => {
              setPassword(value);
              setPasswordError(undefined);
              setConfirmError(undefined);
              setFormError(undefined);
            }}
            placeholder="Enter your new password"
            autoComplete="new-password"
            name="new-password"
            error={passwordError}
            disabled={saving || sendingReauth}
          />
          <AuthInput
            label="Confirm Password"
            icon="lock"
            type="password"
            value={confirmPassword}
            onChange={(value) => {
              setConfirmPassword(value);
              setConfirmError(undefined);
              setFormError(undefined);
            }}
            placeholder="Re-enter your new password"
            autoComplete="new-password"
            name="confirm-password"
            error={confirmError}
            disabled={saving || sendingReauth}
          />
          {reauthRequired && (
            <>
              <div className="auth-banner" role="status">{reauthMessage}</div>
              <AuthInput
                label="Verification code"
                icon="lock"
                value={reauthCode}
                onChange={(value) => {
                  setReauthCode(value);
                  setFormError(undefined);
                }}
                autoComplete="one-time-code"
                name="reauthentication-code"
                disabled={saving || sendingReauth}
                required
              />
              <button
                type="button"
                className="auth-link-btn t-xs"
                disabled={saving || sendingReauth}
                onClick={async () => {
                  if (!supabase || sendingReauth) return;
                  setSendingReauth(true);
                  setFormError(undefined);
                  try {
                    const { error } = await supabase.auth.reauthenticate();
                    if (error) setFormError(getRecoveryError(error, 'reauthenticate'));
                  } catch (error) {
                    setFormError(getRecoveryError(error, 'reauthenticate'));
                  } finally {
                    setSendingReauth(false);
                  }
                }}
              >
                {sendingReauth ? 'Sending verification code…' : 'Send a new verification code'}
              </button>
            </>
          )}
          <AuthButton type="submit" loading={saving} disabled={sendingReauth} style={{ marginTop: 8 }}>
            Reset Password
          </AuthButton>
        </form>
      )}

      {recoveryState === 'success' && (
        <>
          <div className="auth-banner success" role="status">
            <Icon name="check-circle" style={{ stroke: 'var(--ag-success)' }} />
            <span>{successMessage}</span>
          </div>
          <AuthButton onClick={() => navigate('/login', { replace: true })}>Continue to Login</AuthButton>
        </>
      )}
    </AuthShell>
  );
}
