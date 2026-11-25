import type { EmailConfirmationOtpType } from '../types/auth';

type AuthCallbackKind =
  | 'provider-error'
  | 'existing-google-email-login'
  | 'email-confirmation'
  | 'authorization-code'
  | 'implicit-session'
  | 'invalid-email-confirmation'
  | 'missing';

interface AuthCallbackResolution {
  kind: AuthCallbackKind;
  code?: string;
  tokenHash?: string;
  type?: EmailConfirmationOtpType;
  error?: string;
  errorDescription?: string;
  emailConfirmation?: boolean;
}

function isEmailConfirmationOtpType(type: string | null): type is EmailConfirmationOtpType {
  return type === 'signup' || type === 'email';
}

export function resolveAuthCallback(
  search: string,
  hash: string,
  hasGoogleSignupIntent: boolean,
): AuthCallbackResolution {
  const searchParams = search.replace(/^\?/, '');
  const hashParams = hash.replace(/^#/, '');
  const params = new URLSearchParams([searchParams, hashParams].filter(Boolean).join('&'));
  const flow = params.get('flow');
  const code = params.get('code')?.trim() || undefined;
  const tokenHash = params.get('token_hash')?.trim() || undefined;
  const typeValue = params.get('type');
  const type = isEmailConfirmationOtpType(typeValue) ? typeValue : undefined;
  const error = params.get('error_code') ?? params.get('error') ?? undefined;

  if (error) {
    return {
      kind: 'provider-error',
      error,
      errorDescription: params.get('error_description') ?? undefined,
      emailConfirmation: flow === 'email-confirmation' || isEmailConfirmationOtpType(typeValue),
    };
  }

  if (flow === 'existing-google-login') {
    return { kind: 'existing-google-email-login', code };
  }

  if (tokenHash) {
    return type
      ? { kind: 'email-confirmation', tokenHash, type }
      : {
          kind: 'invalid-email-confirmation',
          error: 'Email confirmation failed: the verification type is missing or unsupported.',
        };
  }

  if (code) {
    return {
      kind: 'authorization-code',
      code,
      type,
      emailConfirmation: Boolean(type),
    };
  }

  if (params.has('access_token') || params.has('refresh_token')) {
    return type
      ? { kind: 'email-confirmation', type }
      : { kind: 'implicit-session' };
  }

  if (typeValue === 'signup' || typeValue === 'email') {
    return {
      kind: 'invalid-email-confirmation',
      error: 'Email confirmation failed: the link did not contain a verification token or session.',
    };
  }

  if (hasGoogleSignupIntent) return { kind: 'implicit-session' };
  return { kind: 'missing' };
}
