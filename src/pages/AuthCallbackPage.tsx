import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { AuthButton } from '../components/auth/AuthButton';
import { AuthShell } from '../components/auth/AuthShell';
import { Icon } from '../assets/icons';
import { useAuth, type GoogleSignupIntent } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { resolveAuthCallback } from '../utils/authCallback';
import {
  logAuthInteractionDiagnostic,
  recordAuthDiagnosticNavigation,
} from '../utils/authInteractionDiagnostics';

const GOOGLE_SIGNUP_INTENT_KEY = 'artguard.googleSignupIntent';
const CALLBACK_TIMEOUT_MS = 20000;

function readGoogleSignupIntent(): GoogleSignupIntent | undefined {
  let stored: string | null;
  try {
    stored = sessionStorage.getItem(GOOGLE_SIGNUP_INTENT_KEY);
  } catch {
    return undefined;
  }
  if (!stored) return undefined;
  try {
    const intent: unknown = JSON.parse(stored);
    if (
      typeof intent === 'object'
      && intent !== null
      && ('role' in intent)
      && (intent.role === 'artist' || intent.role === 'client')
      && ('startedAt' in intent)
      && typeof intent.startedAt === 'number'
      && Number.isFinite(intent.startedAt)
    ) {
      return {
        role: intent.role,
        startedAt: intent.startedAt,
        ...('userId' in intent && typeof intent.userId === 'string' ? { userId: intent.userId } : {}),
        ...('step' in intent && (intent.step === 'name' || intent.step === 'interests') ? { step: intent.step } : {}),
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function withCallbackTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('oauth_callback_timeout')), CALLBACK_TIMEOUT_MS);
    operation.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export function AuthCallbackPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const signupIntent = readGoogleSignupIntent();
  const currentCallback = resolveAuthCallback(location.search, location.hash, Boolean(signupIntent));
  const emailCallback = currentCallback.kind === 'email-confirmation'
    || currentCallback.kind === 'invalid-email-confirmation'
    || (currentCallback.kind === 'authorization-code'
      && (currentCallback.emailConfirmation || !signupIntent))
    || (currentCallback.kind === 'provider-error' && currentCallback.emailConfirmation);
  const {
    completeEmailConfirmation,
    completeGoogleSignIn,
    completeExistingGoogleEmailLogin,
  } = useAuth();
  const [error, setError] = useState<string>();
  const [processing, setProcessing] = useState(true);
  const [retryable, setRetryable] = useState(false);
  const [emailConfirmed, setEmailConfirmed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const handledAttempt = useRef<number | null>(null);

  useEffect(() => {
    const intent = readGoogleSignupIntent();
    const callback = resolveAuthCallback(location.search, location.hash, Boolean(intent));
    const isEmailFlow = callback.kind === 'email-confirmation'
      || callback.kind === 'invalid-email-confirmation'
      || (callback.kind === 'authorization-code' && (callback.emailConfirmation || !intent))
      || (callback.kind === 'provider-error' && callback.emailConfirmation);
    const isExistingGoogleEmailLogin = callback.kind === 'existing-google-email-login';

    if (callback.kind === 'provider-error') {
      handledAttempt.current = attempt;
      const description = callback.errorDescription?.trim();
      const cancelled = callback.error === 'access_denied' || callback.error === 'user_cancelled';
      setError(isEmailFlow
        ? `Email confirmation failed: ${description || 'the verification link was rejected or expired.'}`
        : cancelled
          ? isExistingGoogleEmailLogin
            ? 'Email sign-in was cancelled. Please request a new sign-in link.'
            : 'Google sign-in was cancelled or declined. You can try again.'
          : isExistingGoogleEmailLogin
            ? 'This email sign-in link could not be completed. Please request a new one.'
            : 'Google sign-in could not be completed. Please try again.');
      setRetryable(false);
      setProcessing(false);
      return;
    }

    if (handledAttempt.current === attempt) return;
    handledAttempt.current = attempt;
    setError(undefined);
    setRetryable(false);
    setEmailConfirmed(false);
    setProcessing(true);

    const completion = async () => {
      if (callback.kind === 'invalid-email-confirmation') {
        return { success: false, error: callback.error };
      }

      if (callback.kind === 'email-confirmation' && callback.tokenHash) {
        return completeEmailConfirmation({
          tokenHash: callback.tokenHash,
          type: callback.type,
        });
      }
      if (callback.kind === 'email-confirmation') return completeEmailConfirmation();

      if (callback.kind === 'authorization-code' || isExistingGoogleEmailLogin && callback.code) {
        if (!supabase) {
          return { success: false, error: 'Email confirmation requires a configured Supabase connection.' };
        }
        const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(callback.code!);
        if (exchangeError) {
          const message = exchangeError.message || 'the authorization code is invalid or expired.';
          return {
            success: false,
            error: isEmailFlow
              ? `Email confirmation failed: ${message}`
              : 'Unable to complete sign-in. Please try again.',
          };
        }
        const verifiedUser = data.user ?? data.session?.user;
        if (!verifiedUser || data.session?.user.id !== verifiedUser.id) {
          return {
            success: false,
            error: isEmailFlow
              ? 'Email confirmation failed: Supabase did not establish a valid account session.'
              : 'Unable to verify the sign-in session. Please try again.',
          };
        }
        if (isExistingGoogleEmailLogin) return completeExistingGoogleEmailLogin();
        const providers = verifiedUser.app_metadata?.providers;
        const isGoogleAccount = verifiedUser.app_metadata?.provider === 'google'
          || (Array.isArray(providers) && providers.includes('google'));
        if (callback.emailConfirmation || !isGoogleAccount) {
          return completeEmailConfirmation({ verifiedUserId: verifiedUser.id });
        }
        return completeGoogleSignIn(intent);
      }

      if (isExistingGoogleEmailLogin) return completeExistingGoogleEmailLogin();
      if (callback.kind === 'implicit-session') {
        if (!supabase) {
          return { success: false, error: 'Unable to complete sign-in. Please try again.' };
        }
        const { data, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) {
          return {
            success: false,
            error: isEmailFlow
              ? `Email confirmation failed: ${sessionError.message}`
              : 'Unable to complete sign-in. Please try again.',
          };
        }
        const sessionUser = data.session?.user;
        if (!sessionUser) {
          return {
            success: false,
            error: isEmailFlow
              ? 'Email confirmation failed: no valid session was returned. The link may be expired.'
              : 'Unable to complete sign-in. Please try again.',
          };
        }
        const providers = sessionUser.app_metadata?.providers;
        const isGoogleAccount = sessionUser.app_metadata?.provider === 'google'
          || (Array.isArray(providers) && providers.includes('google'));
        if (isGoogleAccount) return completeGoogleSignIn(intent);
        return completeEmailConfirmation();
      }

      return {
        success: false,
        error: 'This confirmation link is incomplete. Return to Sign up to request another confirmation email.',
      };
    };

    void withCallbackTimeout(completion()).then((result) => {
      if (!result.success || !result.destination) {
        if (result.success && 'emailConfirmed' in result && result.emailConfirmed) {
          setEmailConfirmed(true);
          setProcessing(false);
          return;
        }
        logAuthInteractionDiagnostic('login.failed', {
          success: false,
          method: isEmailFlow ? 'email-confirmation' : isExistingGoogleEmailLogin ? 'google-email-link' : 'google',
        });
        setError(result.error ?? (isEmailFlow
          ? 'Email confirmation failed. The link may be invalid or expired.'
          : 'Unable to complete sign-in. Please try again.'));
        setRetryable(callback.kind !== 'invalid-email-confirmation');
        setProcessing(false);
        return;
      }
      logAuthInteractionDiagnostic('login.completed', {
        success: true,
        method: isEmailFlow ? 'email-confirmation' : isExistingGoogleEmailLogin ? 'google-email-link' : 'google',
      });
      recordAuthDiagnosticNavigation(result.destination, isEmailFlow
        ? 'react-router-email-confirmation-callback'
        : 'react-router-oauth-callback');
      navigate(result.destination, { replace: true });
    }).catch((callbackError: unknown) => {
      setError(callbackError instanceof Error && callbackError.message === 'oauth_callback_timeout'
        ? isEmailFlow
          ? 'Email confirmation is taking longer than expected. Check your connection and try again.'
          : 'Sign-in is taking longer than expected. Check your connection and try again.'
        : isEmailFlow
          ? 'Email confirmation failed. The link may be invalid or expired.'
          : 'Unable to complete sign-in. Please try again.');
      setRetryable(true);
      setProcessing(false);
    });
  }, [
    attempt,
    completeEmailConfirmation,
    completeExistingGoogleEmailLogin,
    completeGoogleSignIn,
    location.hash,
    location.search,
    navigate,
  ]);

  const retry = () => {
    setError(undefined);
    setRetryable(false);
    setProcessing(true);
    setAttempt((current) => current + 1);
  };

  return (
    <AuthShell
      brandHeader
      title={emailConfirmed
        ? 'Email confirmed'
        : emailCallback
          ? 'Confirming your email'
          : currentCallback.kind === 'existing-google-email-login'
            ? 'Finishing email sign-in'
            : 'Finishing sign-in'}
      subtitle={
        processing
          ? 'Verifying your account and preparing your profile.'
          : emailConfirmed
            ? 'Your email is confirmed. You can now sign in.'
            : undefined
      }
      onBack={() => navigate('/login', { replace: true })}
    >
      {error ? (
        <>
          <div className="auth-banner error" role="alert">
            <Icon name="alert" style={{ stroke: 'var(--ag-danger)' }} />
            <span>{error}</span>
          </div>
          {retryable && <AuthButton onClick={retry} style={{ marginBottom: 10 }}>Try again</AuthButton>}
          <AuthButton onClick={() => navigate('/login', { replace: true })}>Back to Login</AuthButton>
        </>
      ) : emailConfirmed ? (
        <>
          <div className="auth-banner" role="status">
            <span>Your email is confirmed. You can now sign in to ArtGuard Hub.</span>
          </div>
          <AuthButton onClick={() => navigate('/login', { replace: true })}>Go to Login</AuthButton>
        </>
      ) : (
        <div className="auth-banner" role="status">
          <span>{processing ? 'Please wait...' : 'Sign-in complete. Redirecting...'}</span>
        </div>
      )}
    </AuthShell>
  );
}
