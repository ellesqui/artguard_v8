import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useIonRouter } from '@ionic/react';
import { AuthShell } from '../components/auth/AuthShell';
import { AuthInput } from '../components/auth/AuthInput';
import { AuthButton } from '../components/auth/AuthButton';
import { GoogleIdentityLoginButton } from '../components/auth/GoogleIdentityLoginButton';
import { Icon } from '../assets/icons';
import { useAuth } from '../context/AuthContext';
import { validateEmailField, validateRequired } from '../utils/validators';
import {
  logAuthInteractionDiagnostic,
  recordAuthDiagnosticNavigation,
} from '../utils/authInteractionDiagnostics';

interface FormErrors {
  email?: string;
  password?: string;
}

export function LoginPage() {
  const ionRouter = useIonRouter();
  const { login, completeExistingGoogleLogin } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | undefined>();
  const [googleRetrySeconds, setGoogleRetrySeconds] = useState(0);
  const googleLoginInFlight = useRef(false);

  useEffect(() => {
    if (googleRetrySeconds <= 0) return undefined;
    const timer = window.setTimeout(
      () => setGoogleRetrySeconds((remaining) => Math.max(0, remaining - 1)),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [googleRetrySeconds]);

  const handleGoogleCredential = async (credential: string) => {
    if (googleLoginInFlight.current || googleRetrySeconds > 0) return;
    googleLoginInFlight.current = true;
    setFormError(undefined);
    setGoogleSubmitting(true);
    logAuthInteractionDiagnostic('login.started', { destination: '/home', method: 'google' });
    let result: Awaited<ReturnType<typeof completeExistingGoogleLogin>>;
    try {
      result = await completeExistingGoogleLogin(credential);
    } catch {
      logAuthInteractionDiagnostic('login.failed', { success: false, method: 'google' });
      setFormError('Unable to sign in with Google right now. Please try again.');
      setGoogleSubmitting(false);
      googleLoginInFlight.current = false;
      return;
    }
    if (!result.success) {
      logAuthInteractionDiagnostic('login.failed', { success: false, method: 'google' });
      setFormError(result.error ?? 'Unable to start Google sign-in. Please try again.');
      setGoogleRetrySeconds(result.retryAfterSeconds ?? 0);
      setGoogleSubmitting(false);
      googleLoginInFlight.current = false;
      return;
    }
    logAuthInteractionDiagnostic('login.completed', { success: true, method: 'google' });
    recordAuthDiagnosticNavigation('/home', 'ionic-useIonRouter-root-replace');
    googleLoginInFlight.current = false;
    setGoogleSubmitting(false);
    ionRouter.push('/home', 'root', 'replace');
  };

  const validate = (): boolean => {
    const nextErrors: FormErrors = {
      email: validateEmailField(email),
      password: validateRequired(password, 'Password'),
    };
    setErrors(nextErrors);
    return !nextErrors.email && !nextErrors.password;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(undefined);
    if (!validate()) return;

    setSubmitting(true);
    logAuthInteractionDiagnostic('login.started', { destination: '/home' });
    let result: Awaited<ReturnType<typeof login>>;
    try {
      result = await login(email, password);
    } catch {
      logAuthInteractionDiagnostic('login.failed', { success: false });
      setSubmitting(false);
      setFormError('Unable to sign in right now. Please try again.');
      return;
    }
    setSubmitting(false);

    if (!result.success) {
      logAuthInteractionDiagnostic('login.failed', { success: false });
      setFormError(result.error ?? 'Something went wrong. Please try again.');
      return;
    }
    logAuthInteractionDiagnostic('login.completed', { success: true });
    recordAuthDiagnosticNavigation('/home', 'ionic-useIonRouter-root-replace');
    ionRouter.push('/home', 'root', 'replace');
  };

  return (
    <AuthShell
      authMode="login"
      brandHeader
      title="Sign in to your account"
      subtitle="Access your studio, artwork, and commissions securely."
    >
      {formError && (
        <div className="auth-banner error" role="alert">
          <Icon name="alert" style={{ stroke: 'var(--ag-danger)' }} />
          <span>{formError}</span>
        </div>
      )}
      <form onSubmit={handleSubmit} noValidate>
        <AuthInput
          label="Email address"
          icon="mail"
          type="email"
          value={email}
          onChange={(v) => {
            setEmail(v);
            if (errors.email) setErrors((prev) => ({ ...prev, email: undefined }));
          }}
          placeholder="maren@studio.com"
          autoComplete="email"
          name="email"
          error={errors.email}
        />
        <AuthInput
          label="Password"
          icon="lock"
          type="password"
          value={password}
          onChange={(v) => {
            setPassword(v);
            if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }));
          }}
          placeholder="••••••••••"
          autoComplete="current-password"
          name="password"
          error={errors.password}
        />

        <div style={{ textAlign: 'right', marginBottom: 22 }}>
          <button
            type="button"
            className="auth-link-btn t-xs"
            onClick={() => ionRouter.push('/forgot-password', 'forward')}
          >
            Forgot password?
          </button>
        </div>

        <AuthButton type="submit" loading={submitting} style={{ marginBottom: 18 }}>
          Log In
        </AuthButton>
      </form>

      <div className="row gap-10" style={{ marginBottom: 18 }}>
        <div style={{ flex: 1, height: 1, background: 'var(--ag-border-soft)' }} />
        <span className="t-xs c-low">or continue with</span>
        <div style={{ flex: 1, height: 1, background: 'var(--ag-border-soft)' }} />
      </div>

      <GoogleIdentityLoginButton
        disabled={googleSubmitting || googleRetrySeconds > 0}
        onCredential={(credential) => void handleGoogleCredential(credential)}
        onError={(message) => {
          setFormError(message);
        }}
      />
      {googleRetrySeconds > 0 && (
        <p className="t-xs c-low" role="status" style={{ textAlign: 'center', marginBottom: 12 }}>
          Try Google sign-in again in {googleRetrySeconds} seconds.
        </p>
      )}

      <p className="t-xs c-low auth-footnote">
        New to ArtGuard Hub?{' '}
        <button type="button" className="auth-link-btn t-xs" onClick={() => ionRouter.push('/signup', 'forward')}>
          Create an artist account
        </button>
      </p>
    </AuthShell>
  );
}
