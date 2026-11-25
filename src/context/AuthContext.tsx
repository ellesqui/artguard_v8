import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';
import type { AuthResult, AuthUser, MockAccount, UserRole } from '../types/auth';
import { isSupabaseConfigured, supabase, supabaseUrl } from '../lib/supabase';
import { getMyProfile, ensureMyProfile, usernameFromEmail } from '../lib/supabaseData';
import { validatePasswordField } from '../utils/validators';
import {
  installAuthInteractionDiagnostics,
  logAuthInteractionDiagnostic,
  updateAuthInteractionDiagnosticState,
} from '../utils/authInteractionDiagnostics';

const ACCOUNTS_KEY = 'artguard.mockAccounts';
const SESSION_KEY = 'artguard.session';
const MOCK_LATENCY_MS = 650;
const MOCK_PASSWORD_HASH_ITERATIONS = 600_000;
const MOCK_PASSWORD_SALT_BYTES = 16;
type ProfileUpdatePatch = Partial<Omit<AuthUser, 'isPro'>>;
type AuthOperation = 'login' | 'signup' | 'oauth';
type AuthenticatedDestination = '/home' | '/onboarding/name' | '/onboarding/interests';
const GOOGLE_SIGNUP_INTENT_KEY = 'artguard.googleSignupIntent';
const GOOGLE_NAME_ONBOARDING_KEY = 'artguard.googleNameOnboarding';

export interface GoogleSignupIntent {
  role: UserRole;
  startedAt: number;
  userId?: string;
  step?: 'name' | 'interests';
}

function clearGoogleSignupIntent() {
  try {
    sessionStorage.removeItem(GOOGLE_SIGNUP_INTENT_KEY);
  } catch {
    // Session storage may be unavailable in restrictive browser modes.
  }
}

function googleDisplayName(authUser: SupabaseAuthUser): string | undefined {
  for (const key of ['full_name', 'name']) {
    const value = authUser.user_metadata?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function storeGoogleNameOnboarding(userId: string, name: string) {
  try {
    sessionStorage.setItem(GOOGLE_NAME_ONBOARDING_KEY, JSON.stringify({ userId, name }));
  } catch {
    console.warn('ArtGuard: could not preserve Google name onboarding state for refresh.');
  }
}

function clearGoogleNameOnboarding() {
  try {
    sessionStorage.removeItem(GOOGLE_NAME_ONBOARDING_KEY);
  } catch {
    // Session storage may be unavailable in restrictive browser modes.
  }
}

export function updateGoogleSignupIntent(
  userId: string,
  update: Partial<Pick<GoogleSignupIntent, 'step'>>,
) {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(GOOGLE_SIGNUP_INTENT_KEY) ?? 'null');
    if (
      typeof stored === 'object'
      && stored !== null
      && 'userId' in stored
      && stored.userId === userId
    ) {
      sessionStorage.setItem(GOOGLE_SIGNUP_INTENT_KEY, JSON.stringify({ ...stored, ...update }));
    }
  } catch {
    console.warn('ArtGuard: could not update Google signup recovery state.');
  }
}

export function completeGoogleSignupOnboarding(userId: string) {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(GOOGLE_SIGNUP_INTENT_KEY) ?? 'null');
    if (
      typeof stored === 'object'
      && stored !== null
      && 'userId' in stored
      && stored.userId === userId
    ) {
      clearGoogleSignupIntent();
      clearGoogleNameOnboarding();
    }
  } catch {
    console.warn('ArtGuard: could not clear completed Google signup recovery state.');
  }
}

interface AuthErrorMetadata {
  code?: string;
  name?: string;
  status?: number;
}

function getAuthErrorMetadata(error: unknown): AuthErrorMetadata {
  if (typeof error !== 'object' || error === null) return {};
  const value = error as Record<string, unknown>;
  return {
    ...(typeof value.code === 'string' ? { code: value.code.toLowerCase() } : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.status === 'number' ? { status: value.status } : {}),
  };
}

function safeAuthErrorMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('message' in error) || typeof error.message !== 'string') {
    return undefined;
  }
  return error.message
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[redacted-id]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-token]')
    .slice(0, 240);
}

function logAuthRequestFailure(operation: AuthOperation, error: unknown) {
  const { code, status } = getAuthErrorMetadata(error);
  console.warn('ArtGuard: authentication request failed.', {
    operation,
    code: code ?? 'unknown',
    status: status ?? null,
  });
}

function getRetryAfterSeconds(response: Response): number | undefined {
  const retryAfter = response.headers.get('Retry-After');
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const retryAt = Date.parse(retryAfter);
  if (!Number.isFinite(retryAt)) return undefined;
  const remaining = Math.ceil((retryAt - Date.now()) / 1000);
  return remaining > 0 ? remaining : undefined;
}

function getAuthErrorMessage(error: unknown, operation: AuthOperation): string {
  const { code, name, status } = getAuthErrorMetadata(error);

  if (operation === 'login' && code === 'invalid_credentials') return 'Invalid email or password.';
  if (operation === 'login' && code === 'email_not_confirmed') {
    return 'Please confirm your email before signing in.';
  }
  if (operation === 'signup' && ['email_exists', 'user_already_exists', 'user_already_registered'].includes(code ?? '')) {
    return 'An account with this email may already exist. Try signing in or resetting your password.';
  }
  if (status === 429 || ['over_request_rate_limit', 'over_email_send_rate_limit', 'rate_limit_exceeded', 'too_many_requests'].includes(code ?? '')) {
    return 'Too many attempts. Please wait a little before trying again.';
  }
  if (
    code === 'network_error' ||
    name === 'AuthRetryableFetchError' ||
    (error instanceof TypeError && /fetch|network/i.test(error.message))
  ) {
    return 'Unable to connect. Check your connection and try again.';
  }
  return operation === 'login'
    ? 'Unable to sign in right now. Please try again.'
    : 'Unable to create your account right now. Please try again.';
}

function delay<T>(value: T, ms = MOCK_LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function readAccounts(): MockAccount[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    return raw ? (JSON.parse(raw) as MockAccount[]) : [];
  } catch {
    return [];
  }
}

function writeAccounts(accounts: MockAccount[]) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

function secureMockAuthAvailable(): boolean {
  return Boolean(globalThis.crypto?.subtle && globalThis.crypto?.getRandomValues);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function deriveMockPasswordHash(password: string, salt: Uint8Array): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const saltBuffer = new ArrayBuffer(salt.byteLength);
  new Uint8Array(saltBuffer).set(salt);
  const derivedBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: saltBuffer,
      iterations: MOCK_PASSWORD_HASH_ITERATIONS,
    },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(derivedBits));
}

async function createMockPasswordCredential(
  password: string,
  salt = globalThis.crypto.getRandomValues(new Uint8Array(MOCK_PASSWORD_SALT_BYTES)),
): Promise<Pick<MockAccount, 'passwordHash' | 'passwordSalt'>> {
  return {
    passwordHash: await deriveMockPasswordHash(password, salt),
    passwordSalt: bytesToHex(salt),
  };
}

function hashesMatch(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function verifyMockPassword(account: MockAccount, password: string): Promise<boolean> {
  if (
    typeof account.passwordHash !== 'string'
    || !/^[a-f0-9]{64}$/i.test(account.passwordHash)
    || typeof account.passwordSalt !== 'string'
    || !/^[a-f0-9]{32}$/i.test(account.passwordSalt)
  ) {
    return false;
  }
  const actualHash = await deriveMockPasswordHash(password, hexToBytes(account.passwordSalt));
  return hashesMatch(actualHash, account.passwordHash.toLowerCase());
}

function toPublicUser(account: MockAccount): AuthUser {
  const {
    password: _password,
    passwordHash: _passwordHash,
    passwordSalt: _passwordSalt,
    dateOfBirth: _dateOfBirth,
    ...publicUser
  } = account;
  return publicUser;
}

const mockApi = {
  async signUp(
    name: string,
    email: string,
    password: string,
    role: UserRole,
  ): Promise<AuthResult & { user?: AuthUser }> {
    if (!secureMockAuthAvailable()) {
      return delay({ success: false, error: 'Secure local account storage is unavailable in this browser.' });
    }
    const accounts = readAccounts();
    const normalizedEmail = email.trim().toLowerCase();
    if (accounts.some((a) => a.email.toLowerCase() === normalizedEmail)) {
      return delay({ success: false, error: 'An account with that email already exists.' });
    }
    const passwordCredential = await createMockPasswordCredential(password);
    const account: MockAccount = {
      id: `usr_${Date.now().toString(36)}`,
      name: name.trim(),
      email: normalizedEmail,
      username: usernameFromEmail(normalizedEmail),
      role,
      createdAt: new Date().toISOString(),
      ...passwordCredential,
    };
    writeAccounts([...accounts, account]);
    return delay({ success: true, user: toPublicUser(account) });
  },
  async login(email: string, password: string): Promise<AuthResult & { user?: AuthUser }> {
    if (!secureMockAuthAvailable()) {
      return delay({ success: false, error: 'Secure local sign-in is unavailable in this browser.' });
    }
    const accounts = readAccounts();
    const normalizedEmail = email.trim().toLowerCase();
    const account = accounts.find((a) => a.email.toLowerCase() === normalizedEmail);
    if (!account) return delay({ success: false, error: 'No account found with that email.' });
    if (typeof account.password === 'string') {
      if (account.password !== password) return delay({ success: false, error: 'Incorrect password. Try again.' });
      const passwordCredential = await createMockPasswordCredential(password);
      const migratedAccount: MockAccount = { ...account, ...passwordCredential, password: undefined };
      writeAccounts(accounts.map((candidate) => candidate.id === account.id ? migratedAccount : candidate));
      return delay({ success: true, user: toPublicUser(migratedAccount) });
    }
    if (!await verifyMockPassword(account, password)) {
      return delay({ success: false, error: 'Incorrect password. Try again.' });
    }
    return delay({ success: true, user: toPublicUser(account) });
  },
  async requestPasswordReset(_email: string): Promise<AuthResult> {
    return delay({
      success: false,
      error: 'Password reset emails are unavailable in demo mode. Connect to Supabase to request a real reset email.',
    });
  },
  async updateProfile(userId: string, patch: Partial<AuthUser>): Promise<AuthResult & { user?: AuthUser }> {
    const accounts = readAccounts();
    const index = accounts.findIndex((a) => a.id === userId);
    if (index === -1) return delay({ success: false, error: 'Account not found.' }, 150);
    const updated: MockAccount = { ...accounts[index], ...patch };
    const nextAccounts = [...accounts];
    nextAccounts[index] = updated;
    writeAccounts(nextAccounts);
    return delay({ success: true, user: toPublicUser(updated) }, 150);
  },
};

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  initializing: boolean;
  sessionRecoveryError: string | null;
  retrySessionRecovery: () => Promise<void>;
  backendMode: 'supabase' | 'mock';
  login: (email: string, password: string) => Promise<AuthResult>;
  signUp: (name: string, email: string, password: string, role: UserRole) => Promise<AuthResult>;
  resendSignupConfirmation: (email: string) => Promise<AuthResult>;
  completeExistingGoogleLogin: (credential: string) => Promise<AuthResult>;
  completeExistingGoogleEmailLogin: () => Promise<AuthResult & { destination?: AuthenticatedDestination }>;
  startGoogleSignIn: (role?: UserRole) => Promise<AuthResult>;
  completeGoogleSignIn: (intent?: GoogleSignupIntent) => Promise<AuthResult & { destination?: AuthenticatedDestination }>;
  changeEmail: (email: string) => Promise<AuthResult>;
  deactivateAccount: () => Promise<AuthResult & { warning?: string }>;
  requestAccountDeletion: () => Promise<AuthResult>;
  requestPasswordReset: (email: string) => Promise<AuthResult>;
  passwordRecoverySession: boolean;
  clearPasswordRecoverySession: () => void;
  updateProfile: (patch: ProfileUpdatePatch) => Promise<AuthResult>;
  enableMockPremium: () => Promise<AuthResult>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

type SupabaseAuthUser = {
  id: string;
  email?: string | null;
  created_at?: string;
  user_metadata?: Record<string, unknown>;
};

class DeactivatedAccountError extends Error {
  constructor() {
    super('This account is deactivated. Contact support to request reactivation.');
    this.name = 'DeactivatedAccountError';
  }
}

async function revokeInactiveSession(): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut({ scope: 'global' });
  if (!error) return;

  console.error('ArtGuard: could not revoke all sessions for a deactivated account.', error);
  const { error: localError } = await supabase.auth.signOut({ scope: 'local' });
  if (localError) {
    console.error('ArtGuard: could not clear the local session for a deactivated account.', localError);
  }
}

function authUserFromMetadata(authUser: SupabaseAuthUser): AuthUser {
  const metadataName = authUser.user_metadata?.full_name ?? authUser.user_metadata?.name;
  const metadataRole = authUser.user_metadata?.role;
  return {
    id: authUser.id,
    name: typeof metadataName === 'string' && metadataName.trim()
      ? metadataName
      : authUser.email?.split('@')[0] ?? 'User',
    email: authUser.email ?? '',
    username: usernameFromEmail(authUser.email),
    role: metadataRole === 'artist' ? 'artist' : 'client',
    createdAt: authUser.created_at,
    onboarded: Boolean(authUser.user_metadata?.onboarded),
  };
}

async function publicUserFromSession(
  authUser: SupabaseAuthUser,
  onProfileUnavailable?: () => void,
): Promise<AuthUser> {
  if (supabase) {
    const { data: isActive, error } = await supabase.rpc('is_my_account_active');
    if (error) throw error;
    if (isActive !== true) throw new DeactivatedAccountError();
  }

  const fallback = authUserFromMetadata(authUser);
  let profile = null;
  try {
    profile = await getMyProfile(authUser.id);
  } catch (error) {
    onProfileUnavailable?.();
    console.warn('ArtGuard: profile lookup failed; using auth metadata for now.', error);
  }

  return {
    ...fallback,
    name: profile?.name ?? fallback.name,
    username: profile?.username ?? fallback.username,
    role: profile?.role ?? fallback.role,
    bio: profile?.bio ?? undefined,
    interests: profile?.interests ?? undefined,
    avatarDataUrl: profile?.avatar_data_url ?? undefined,
    onboarded: Boolean(profile?.onboarded ?? fallback.onboarded),
    isPro: Boolean(profile?.is_pro),
    lastSeenAt: profile?.last_seen_at ?? undefined,
    artistVerificationStatus: profile?.artist_verification_status ?? undefined,
    artistVerificationSubmittedAt: profile?.artist_verification_submitted_at ?? undefined,
    artistVerificationReviewedAt: profile?.artist_verification_reviewed_at ?? undefined,
    artistVerificationReviewedBy: profile?.artist_verification_reviewed_by ?? undefined,
    artistVerificationRejectionReason: profile?.artist_verification_rejection_reason ?? undefined,
    artistVerificationArtworkId: profile?.artist_verification_artwork_id ?? undefined,
    isAdmin: Boolean(profile?.is_admin),
  };
}

async function refreshProfileForUser(userId: string, fallback: AuthUser): Promise<AuthUser> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const profile = await getMyProfile(userId);
      if (profile) {
        return {
          ...fallback,
          name: profile.name ?? fallback.name,
          username: profile.username ?? fallback.username,
          role: profile.role ?? fallback.role,
          bio: profile.bio ?? undefined,
          interests: profile.interests ?? undefined,
          avatarDataUrl: profile.avatar_data_url ?? undefined,
          onboarded: Boolean(profile.onboarded),
          isPro: Boolean(profile.is_pro),
          lastSeenAt: profile.last_seen_at ?? undefined,
          artistVerificationStatus: profile.artist_verification_status ?? undefined,
          artistVerificationSubmittedAt: profile.artist_verification_submitted_at ?? undefined,
          artistVerificationReviewedAt: profile.artist_verification_reviewed_at ?? undefined,
          artistVerificationReviewedBy: profile.artist_verification_reviewed_by ?? undefined,
          artistVerificationRejectionReason: profile.artist_verification_rejection_reason ?? undefined,
          artistVerificationArtworkId: profile.artist_verification_artwork_id ?? undefined,
          isAdmin: Boolean(profile.is_admin),
        };
      }
    } catch (error) {
      if (attempt === 3) console.warn('ArtGuard: profile refresh failed.', error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return fallback;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [sessionRecoveryError, setSessionRecoveryError] = useState<string | null>(null);
  const [passwordRecoverySession, setPasswordRecoverySession] = useState(false);
  const authStateRevision = useRef(0);
  const googleLoginInFlight = useRef<Promise<AuthResult> | null>(null);
  const googleLoginRetryAt = useRef(0);

  useEffect(() => {
    updateAuthInteractionDiagnosticState({
      initializing,
      hasUser: Boolean(user),
      isAuthenticated: Boolean(user),
      supabaseConfigured: isSupabaseConfigured,
    });
  }, [initializing, user]);

  useEffect(() => installAuthInteractionDiagnostics(), []);

  useEffect(() => {
    let active = true;
    logAuthInteractionDiagnostic('auth.initialization.started', {
      initializing: true,
      hasUser: false,
      isAuthenticated: false,
      supabaseConfigured: isSupabaseConfigured,
    });
    if (!isSupabaseConfigured || !supabase) {
      let hasUser = false;
      try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (raw) {
          setUser(JSON.parse(raw) as AuthUser);
          hasUser = true;
        }
      } finally {
        setInitializing(false);
        logAuthInteractionDiagnostic('auth.initialization.completed', {
          initializing: false,
          hasUser,
          isAuthenticated: hasUser,
          supabaseConfigured: false,
        });
      }
      return;
    }

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      logAuthInteractionDiagnostic('auth.state.changed', {
        eventType: event,
        hasUser: Boolean(session?.user),
        initializing,
        isAuthenticated: Boolean(session?.user),
        supabaseConfigured: true,
      });
      if (event === 'TOKEN_REFRESHED') return;
      const revision = ++authStateRevision.current;
      if (!session?.user) {
        if (event === 'SIGNED_OUT') {
          setPasswordRecoverySession(false);
          setSessionRecoveryError(null);
        }
        setUser(null);
        if (event === 'INITIAL_SESSION') {
          setInitializing(false);
          logAuthInteractionDiagnostic('auth.initialization.completed', {
            eventType: event,
            initializing: false,
            hasUser: false,
            isAuthenticated: false,
            supabaseConfigured: true,
          });
        }
        return;
      }
      if (window.location.pathname === '/auth/callback') return;
      if (event === 'PASSWORD_RECOVERY') {
        setPasswordRecoverySession(true);
      } else if (event === 'SIGNED_IN') {
        setPasswordRecoverySession(false);
      }
      window.setTimeout(() => {
        let profileUnavailable = false;
        void publicUserFromSession(session.user, () => { profileUnavailable = true; }).then((next) => {
          if (!active || revision !== authStateRevision.current) return;
          setUser(next);
          setSessionRecoveryError(profileUnavailable
            ? 'Your session is active, but your ArtGuard profile could not be loaded. Retry to restore your account.'
            : null);
          if (event === 'INITIAL_SESSION') {
            setInitializing(false);
            logAuthInteractionDiagnostic('auth.initialization.completed', {
              eventType: event,
              initializing: false,
              hasUser: true,
              isAuthenticated: true,
              supabaseConfigured: true,
            });
          }
          if (!profileUnavailable) {
            void refreshProfileForUser(session.user.id, next).then((refreshed) => {
              if (active && revision === authStateRevision.current) setUser(refreshed);
            });
          }
        }).catch((error) => {
          if (active && revision === authStateRevision.current) {
            if (error instanceof DeactivatedAccountError) {
              setUser(null);
              setPasswordRecoverySession(false);
              setSessionRecoveryError(null);
              void revokeInactiveSession().catch((signOutError) => {
                console.error('ArtGuard: failed to sign out a deactivated account.', signOutError);
              });
            } else {
              setUser(authUserFromMetadata(session.user));
              setSessionRecoveryError(
                'Your session is still active, but account details could not be verified. Retry to restore your account.',
              );
            }
            if (event === 'INITIAL_SESSION') {
              setInitializing(false);
              logAuthInteractionDiagnostic('auth.initialization.failed', {
                eventType: event,
                initializing: false,
                hasUser: true,
                isAuthenticated: true,
                supabaseConfigured: true,
              });
            } else {
              logAuthInteractionDiagnostic('auth.state.hydration-failed', {
                eventType: event,
                hasUser: true,
                isAuthenticated: true,
                supabaseConfigured: true,
              });
            }
            console.error('ArtGuard: auth state update failed', error);
          }
        });
      }, 0);
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const persistSession = useCallback((nextUser: AuthUser | null) => {
    setUser(nextUser);
    if (!nextUser) setSessionRecoveryError(null);
    if (!isSupabaseConfigured) {
      if (nextUser) localStorage.setItem(SESSION_KEY, JSON.stringify(nextUser));
      else localStorage.removeItem(SESSION_KEY);
    }
  }, []);

  const retrySessionRecovery = useCallback(async () => {
    if (!supabase) return;
    setInitializing(true);
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      if (!data.session?.user) {
        setUser(null);
        setSessionRecoveryError(null);
        return;
      }

      let profileUnavailable = false;
      const hydratedUser = await publicUserFromSession(data.session.user, () => { profileUnavailable = true; });
      setUser(hydratedUser);
      setSessionRecoveryError(profileUnavailable
        ? 'Your session is active, but your ArtGuard profile could not be loaded. Retry to restore your account.'
        : null);
      if (!profileUnavailable) {
        void refreshProfileForUser(data.session.user.id, hydratedUser).then(persistSession);
      }
    } catch (error) {
      if (error instanceof DeactivatedAccountError) {
        setUser(null);
        setSessionRecoveryError(null);
        void revokeInactiveSession().catch((signOutError) => {
          console.error('ArtGuard: failed to sign out a deactivated account.', signOutError);
        });
      } else {
        setSessionRecoveryError(
          'Your session is still active, but account details could not be verified. Check your connection and retry.',
        );
      }
    } finally {
      setInitializing(false);
    }
  }, [persistSession]);

  const login = useCallback(async (email: string, password: string) => {
    if (!isSupabaseConfigured || !supabase) {
      const result = await mockApi.login(email, password);
      if (result.success && result.user) persistSession(result.user);
      const error = result.error === 'No account found with that email.'
        ? "This account doesn't exist. Create an account first."
        : result.error;
      return { success: result.success, error };
    }

    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        logAuthRequestFailure('login', error);
        return { success: false, error: getAuthErrorMessage(error, 'login') };
      }
      if (!data.user) return { success: false, error: 'Unable to sign in right now. Please try again.' };
      const fallbackUser = await publicUserFromSession(data.user, () => setSessionRecoveryError(
        'Your session is active, but your ArtGuard profile could not be loaded. Retry to restore your account.',
      ));
      try {
        await ensureMyProfile({
          id: data.user.id,
          name: String(data.user.user_metadata?.name ?? data.user.email?.split('@')[0] ?? fallbackUser.name ?? 'User'),
          username: usernameFromEmail(data.user.email),
          role: ((data.user.user_metadata?.role ?? fallbackUser.role ?? 'client') as UserRole),
          onboarded: Boolean(data.user.user_metadata?.onboarded ?? fallbackUser.onboarded),
        });
      } catch (profileError) {
        console.warn('ArtGuard: profile repair during login skipped.', profileError);
      }
      persistSession(fallbackUser);
      return { success: true };
    } catch (error) {
      if (error instanceof DeactivatedAccountError) {
        try {
          await revokeInactiveSession();
        } catch (signOutError) {
          console.error('ArtGuard: failed to sign out a deactivated account.', signOutError);
        }
        return { success: false, error: error.message };
      }
      logAuthRequestFailure('login', error);
      return { success: false, error: getAuthErrorMessage(error, 'login') };
    }
  }, [persistSession]);

  const signUp = useCallback(async (name: string, email: string, password: string, role: UserRole) => {
    const passwordError = validatePasswordField(password);
    if (passwordError) return { success: false, error: passwordError };

    if (!isSupabaseConfigured || !supabase) {
      const result = await mockApi.signUp(name, email, password, role);
      if (result.success && result.user) persistSession(result.user);
      const error = result.error === 'An account with that email already exists.'
        ? 'An account with this email may already exist. Try signing in or resetting your password.'
        : result.error;
      return { success: result.success, error };
    }

    try {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { name: name.trim(), role, onboarded: false } },
      });
      if (error) {
        logAuthRequestFailure('signup', error);
        const { code } = getAuthErrorMetadata(error);
        if (['email_exists', 'user_already_exists', 'user_already_registered'].includes(code ?? '')) {
          return {
            success: false,
            confirmationRequired: true,
            error: 'An account with this email may already exist. If it is awaiting confirmation, request a new confirmation email below.',
          };
        }
        return { success: false, error: getAuthErrorMessage(error, 'signup') };
      }
      if (!data.user || !data.session) {
        return {
          success: false,
          confirmationRequired: true,
          error: "Check your email for confirmation instructions. If you don't receive one, try signing in or resetting your password.",
        };
      }
      let fallbackUser = await publicUserFromSession(data.user, () => setSessionRecoveryError(
        'Your session is active, but your ArtGuard profile could not be loaded. Retry to restore your account.',
      ));
      try {
        const profile = await ensureMyProfile({
          id: data.user.id,
          name: name.trim(),
          username: usernameFromEmail(email),
          role,
          onboarded: false,
        });
        if (profile) {
          fallbackUser = {
            ...fallbackUser,
            name: profile.name,
            role: profile.role,
            bio: profile.bio ?? undefined,
            interests: profile.interests ?? undefined,
            avatarDataUrl: profile.avatar_data_url ?? undefined,
            onboarded: Boolean(profile.onboarded),
            isPro: Boolean(profile.is_pro),
          };
        }
      } catch (profileError) {
        console.error('ArtGuard: could not create profile after signup', profileError);
      }
      persistSession(fallbackUser);
      void refreshProfileForUser(data.user.id, fallbackUser).then(persistSession);
      return { success: true };
    } catch (error) {
      logAuthRequestFailure('signup', error);
      return { success: false, error: getAuthErrorMessage(error, 'signup') };
    }
  }, [persistSession]);

  const resendSignupConfirmation = useCallback(async (email: string): Promise<AuthResult> => {
    if (!isSupabaseConfigured || !supabase) {
      return { success: false, error: 'Email confirmation requires a configured Supabase connection.' };
    }
    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      return { success: false, error: 'Enter the email address used to create your account.' };
    }

    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: normalizedEmail,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) {
        logAuthRequestFailure('signup', error);
        return {
          success: false,
          error: 'Could not request another confirmation email. Wait a little and try again, or contact support.',
        };
      }
      return {
        success: true,
        error: 'The confirmation email request was accepted. Delivery is not confirmed; check your inbox and spam folder.',
      };
    } catch (error) {
      logAuthRequestFailure('signup', error);
      return {
        success: false,
        error: 'Could not request another confirmation email. Check your connection and try again.',
      };
    }
  }, []);

  const startGoogleSignIn = useCallback(async (role?: UserRole): Promise<AuthResult> => {
    if (!isSupabaseConfigured || !supabase) {
      return { success: false, error: 'Google sign-in requires a configured Supabase connection.' };
    }
    if (Capacitor.isNativePlatform()) {
      return { success: false, error: 'Google sign-in on the native app is not configured yet. Please use the web app.' };
    }

    if (role) {
      try {
        const stored: unknown = JSON.parse(sessionStorage.getItem(GOOGLE_SIGNUP_INTENT_KEY) ?? 'null');
        const hasPendingSignup = typeof stored === 'object'
          && stored !== null
          && 'role' in stored
          && (stored.role === 'artist' || stored.role === 'client')
          && 'startedAt' in stored
          && typeof stored.startedAt === 'number'
          && Number.isFinite(stored.startedAt);
        if (!hasPendingSignup) {
          const intent: GoogleSignupIntent = { role, startedAt: Date.now() };
          sessionStorage.setItem(GOOGLE_SIGNUP_INTENT_KEY, JSON.stringify(intent));
        }
      } catch {
        return { success: false, error: 'Unable to start Google sign-in. Please enable session storage and try again.' };
      }
    } else {
      try {
        const stored: unknown = JSON.parse(sessionStorage.getItem(GOOGLE_SIGNUP_INTENT_KEY) ?? 'null');
        const hasBoundPendingSignup = typeof stored === 'object'
          && stored !== null
          && 'userId' in stored
          && typeof stored.userId === 'string';
        if (!hasBoundPendingSignup) clearGoogleSignupIntent();
      } catch {
        clearGoogleSignupIntent();
      }
    }

    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) {
        logAuthRequestFailure('oauth', error);
        return { success: false, error: 'Unable to start Google sign-in. Please try again.' };
      }
      return { success: true };
    } catch (error) {
      logAuthRequestFailure('oauth', error);
      return {
        success: false,
        error: error instanceof TypeError && /fetch|network/i.test(error.message)
          ? 'Unable to connect. Check your connection and try again.'
          : 'Unable to start Google sign-in. Please try again.',
      };
    }
  }, []);

  const completeExistingGoogleLogin = useCallback((credential: string): Promise<AuthResult> => {
    if (googleLoginInFlight.current) return googleLoginInFlight.current;
    const secondsUntilRetry = Math.ceil((googleLoginRetryAt.current - Date.now()) / 1000);
    if (secondsUntilRetry > 0) {
      return Promise.resolve({
        success: false,
        error: `Google sign-in is temporarily rate-limited. Please wait ${secondsUntilRetry} seconds and try again.`,
        retryAfterSeconds: secondsUntilRetry,
      });
    }

    const attempt = (async (): Promise<AuthResult> => {
      if (!isSupabaseConfigured || !supabase) {
        return { success: false, error: 'Google sign-in requires a configured Supabase connection.' };
      }
      if (!credential.trim()) {
        return { success: false, error: 'Google could not verify your account. Please try again.' };
      }

      try {
        if (!supabaseUrl) {
          return { success: false, error: 'Google sign-in requires a configured Supabase connection.' };
        }
        const functionUrl = new URL('/functions/v1/google-login-existing-v2', supabaseUrl);
        const isLocalFunction = functionUrl.hostname === 'localhost' || functionUrl.hostname === '127.0.0.1';
        if (functionUrl.protocol !== 'https:' && !isLocalFunction) {
          return { success: false, error: 'Google sign-in is unavailable over an insecure connection.' };
        }

        const { data, error } = await supabase.functions.invoke('google-login-existing-v2', {
          body: { credential },
        });
        if (error) {
          if (error.context instanceof Response) {
            const response = error.context;
            let failure: unknown;
            try {
              failure = await response.clone().json();
            } catch {
              failure = undefined;
            }
            if (
              response.status === 404
              && typeof failure === 'object'
              && failure !== null
              && 'code' in failure
              && failure.code === 'profile_not_found'
            ) {
              return { success: false, error: 'Your sign-in account exists, but its ArtGuard profile could not be found. Please retry or contact support.' };
            }
            if (
              response.status === 404
              && typeof failure === 'object'
              && failure !== null
              && 'code' in failure
              && failure.code === 'account_not_found'
            ) {
              return { success: false, error: 'This Google account could not be matched to an existing ArtGuard Hub account in this environment.' };
            }
            if (response.status === 429) {
              const retryAfterSeconds = getRetryAfterSeconds(response) ?? 5;
              return {
                success: false,
                error: `Google sign-in is temporarily rate-limited. Please wait ${retryAfterSeconds} seconds and try again.`,
                retryAfterSeconds,
              };
            }
          }
          logAuthRequestFailure('oauth', error);
          return { success: false, error: 'Unable to sign in with Google right now. Please try again.' };
        }
        if (
          typeof data !== 'object'
          || data === null
          || !('accepted' in data)
          || data.accepted !== 'true'
        ) {
          return { success: false, error: 'Unable to sign in with Google right now. Please try again.' };
        }

        const { data: authData, error: authError } = await supabase.auth.signInWithIdToken({
          provider: 'google',
          token: credential,
        });
        if (authError) {
          logAuthRequestFailure('oauth', authError);
          if (authError.status === 429) {
            return {
              success: false,
              error: 'Google sign-in is temporarily rate-limited. Please wait 5 seconds and try again.',
              retryAfterSeconds: 5,
            };
          }
          return { success: false, error: 'Google verified your account, but ArtGuard could not start a session. Please try again.' };
        }
        if (!authData.session || !authData.user) {
          return { success: false, error: 'Google verified your account, but ArtGuard did not receive a session. Please try again.' };
        }

        try {
          let profileUnavailable = false;
          const authenticatedUser = await publicUserFromSession(authData.user, () => { profileUnavailable = true; });
          setSessionRecoveryError(profileUnavailable
            ? 'Your session is active, but your ArtGuard profile could not be loaded. Retry to restore your account.'
            : null);
          persistSession(authenticatedUser);
        } catch (sessionError) {
          if (sessionError instanceof DeactivatedAccountError) {
            await revokeInactiveSession();
            return { success: false, error: sessionError.message };
          }
          console.warn('ArtGuard: Google session established, but account hydration failed.');
          persistSession(authUserFromMetadata(authData.user));
          setSessionRecoveryError(
            'Your session is active, but account details could not be verified. Retry to restore your account.',
          );
        }
        return { success: true };
      } catch (error) {
        logAuthRequestFailure('oauth', error);
        return { success: false, error: 'Unable to sign in with Google right now. Please try again.' };
      }
    })();

    googleLoginInFlight.current = attempt;
    return attempt.then((result) => {
      if (result.retryAfterSeconds) {
        googleLoginRetryAt.current = Date.now() + result.retryAfterSeconds * 1000;
      }
      return result;
    }).finally(() => {
      if (googleLoginInFlight.current === attempt) googleLoginInFlight.current = null;
    });
  }, [persistSession]);

  const completeExistingGoogleEmailLogin = useCallback(async (): Promise<
    AuthResult & { destination?: AuthenticatedDestination }
  > => {
    const authClient = supabase;
    if (!isSupabaseConfigured || !authClient) {
      return { success: false, error: 'Google sign-in requires a configured Supabase connection.' };
    }

    const rejectUnverifiedSession = async (message: string) => {
      try {
        const { error } = await authClient.auth.signOut();
        if (error) logAuthRequestFailure('oauth', error);
      } catch (error) {
        logAuthRequestFailure('oauth', error);
      }
      persistSession(null);
      return { success: false, error: message } as const;
    };

    try {
      const { data: sessionData, error: sessionError } = await authClient.auth.getSession();
      if (sessionError || !sessionData.session) {
        if (sessionError) logAuthRequestFailure('oauth', sessionError);
        return rejectUnverifiedSession('This email sign-in link is invalid or expired. Please try Google Login again.');
      }

      const { data: userData, error: userError } = await authClient.auth.getUser();
      if (userError) {
        logAuthRequestFailure('oauth', userError);
        persistSession(authUserFromMetadata(sessionData.session.user));
        setSessionRecoveryError(
          'Your session is active, but account details could not be verified. Retry to restore your account.',
        );
        setInitializing(false);
        return {
          success: false,
          error: 'Your sign-in is active, but ArtGuard could not verify your account details. Please retry.',
        };
      }
      if (!userData.user || userData.user.id !== sessionData.session.user.id) {
        return rejectUnverifiedSession('Unable to verify this email sign-in. Please try Google Login again.');
      }

      let profile: Awaited<ReturnType<typeof getMyProfile>>;
      try {
        profile = await getMyProfile(userData.user.id);
      } catch (error) {
        logAuthRequestFailure('oauth', error);
        persistSession(authUserFromMetadata(userData.user));
        setSessionRecoveryError(
          'Your session is active, but your ArtGuard profile could not be loaded. Retry to restore your account.',
        );
        setInitializing(false);
        return {
          success: false,
          error: 'Your sign-in is active, but your ArtGuard profile could not be loaded. Please retry.',
        };
      }
      if (!profile || (profile.role !== 'artist' && profile.role !== 'client')) {
        persistSession(authUserFromMetadata(userData.user));
        setSessionRecoveryError(
          'Your session is active, but your ArtGuard profile is unavailable. Retry or contact support.',
        );
        setInitializing(false);
        return {
          success: false,
          error: 'Your sign-in is active, but your ArtGuard profile is unavailable. Please retry.',
        };
      }

      const authenticatedUser: AuthUser = {
        ...authUserFromMetadata(userData.user),
        name: profile.name,
        username: profile.username,
        role: profile.role,
        bio: profile.bio ?? undefined,
        interests: profile.interests ?? undefined,
        avatarDataUrl: profile.avatar_data_url ?? undefined,
        onboarded: Boolean(profile.onboarded),
        isPro: Boolean(profile.is_pro),
        lastSeenAt: profile.last_seen_at ?? undefined,
        artistVerificationStatus: profile.artist_verification_status ?? undefined,
        artistVerificationSubmittedAt: profile.artist_verification_submitted_at ?? undefined,
        artistVerificationReviewedAt: profile.artist_verification_reviewed_at ?? undefined,
        artistVerificationReviewedBy: profile.artist_verification_reviewed_by ?? undefined,
        artistVerificationRejectionReason: profile.artist_verification_rejection_reason ?? undefined,
        artistVerificationArtworkId: profile.artist_verification_artwork_id ?? undefined,
        isAdmin: Boolean(profile.is_admin),
      };
      persistSession(authenticatedUser);
      setSessionRecoveryError(null);
      setInitializing(false);
      return { success: true, destination: '/home' };
    } catch (error) {
      logAuthRequestFailure('oauth', error);
      try {
        const { data, error: sessionError } = await authClient.auth.getSession();
        if (sessionError) throw sessionError;
        if (data.session?.user) {
          persistSession(authUserFromMetadata(data.session.user));
          setSessionRecoveryError(
            'Your session is active, but account details could not be loaded. Retry to restore your account.',
          );
          setInitializing(false);
          return {
            success: false,
            error: 'Your sign-in is active, but account details could not be loaded. Please retry.',
          };
        }
      } catch (sessionError) {
        logAuthRequestFailure('oauth', sessionError);
        setSessionRecoveryError(
          'Sign-in could not be completed. Check your connection and return to Login to try again.',
        );
        setInitializing(false);
        return {
          success: false,
          error: 'Sign-in could not be completed. Check your connection and try again.',
        };
      }
      return rejectUnverifiedSession('Unable to complete sign-in. Please try Google Login again.');
    }
  }, [persistSession]);

  const completeGoogleSignIn = useCallback(async (
    intent?: GoogleSignupIntent,
  ): Promise<AuthResult & { destination?: AuthenticatedDestination }> => {
    if (!isSupabaseConfigured || !supabase) {
      return { success: false, error: 'Google sign-in requires a configured Supabase connection.' };
    }

    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData.session) {
        if (sessionError) logAuthRequestFailure('oauth', sessionError);
        return { success: false, error: 'Unable to complete Google sign-in. Please try again.' };
      }
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user || data.user.id !== sessionData.session.user.id) {
        if (error) logAuthRequestFailure('oauth', error);
        return { success: false, error: 'Unable to verify your Google account. Please try again.' };
      }

      const authUser = data.user;
      const createdAt = Date.parse(authUser.created_at);
      const isBoundSignupIntent = intent?.userId === authUser.id;
      const canBindSignupIntent = intent !== undefined
        && intent.userId === undefined
        && Number.isFinite(createdAt)
        && createdAt >= intent.startedAt;
      const isNewGoogleAccount = isBoundSignupIntent || canBindSignupIntent;
      const signupStep = isNewGoogleAccount ? intent?.step ?? 'name' : undefined;
      if (intent && !isNewGoogleAccount) {
        clearGoogleSignupIntent();
        clearGoogleNameOnboarding();
      }
      if (canBindSignupIntent && intent) {
        intent.userId = authUser.id;
        intent.step = 'name';
        try {
          sessionStorage.setItem(GOOGLE_SIGNUP_INTENT_KEY, JSON.stringify(intent));
        } catch {
          console.warn('ArtGuard: could not bind Google signup recovery state.');
        }
      }
      let existingProfile;
      try {
        existingProfile = await getMyProfile(authUser.id);
      } catch (error) {
        logAuthRequestFailure('oauth', error);
        return {
          success: false,
          error: 'Google authentication succeeded, but your ArtGuard profile could not be loaded. Please try again later or contact support.',
        };
      }
      const metadataName = googleDisplayName(authUser);
      const metadataRole = authUser.user_metadata?.role;
      const role: UserRole = isNewGoogleAccount
        ? intent.role
        : metadataRole === 'artist' ? 'artist' : 'client';
      let profile = existingProfile;
      if (!profile) {
        try {
          profile = await ensureMyProfile({
            id: authUser.id,
            name: String(authUser.user_metadata?.full_name ?? authUser.user_metadata?.name ?? authUser.email?.split('@')[0] ?? 'User'),
            username: usernameFromEmail(authUser.email),
            role,
            onboarded: false,
          });
        } catch (error) {
          logAuthRequestFailure('oauth', error);
          return { success: false, error: 'Unable to create your profile. Check your connection and try again.' };
        }
      }
      if (!profile) {
        return { success: false, error: 'Unable to set up your profile. Please try again.' };
      }
      const isCompletedProfile = Boolean(profile.onboarded || profile.interests?.length);
      const isIncompleteGoogleSignup = isNewGoogleAccount && !isCompletedProfile;
      if (isIncompleteGoogleSignup && profile.role !== role) {
        let roleUpdateError: { code?: string; status?: number; message?: string } | null = null;
        let roleUpdated = false;
        try {
          const { data: updated, error } = await supabase.rpc('set_my_signup_role', {
            p_role: role,
          });
          roleUpdateError = error;
          roleUpdated = updated === true;
        } catch (error) {
          const { code, status } = getAuthErrorMetadata(error);
          console.warn('ArtGuard: Google signup role update failed.', {
            code: code ?? 'unknown',
            status: status ?? null,
            message: safeAuthErrorMessage(error),
          });
          return { success: false, error: 'Unable to save your selected account type. Please try again.' };
        }
        if (roleUpdateError) {
          const { code, status } = getAuthErrorMetadata(roleUpdateError);
          console.warn('ArtGuard: Google signup role update failed.', {
            code: code ?? 'unknown',
            status: status ?? null,
            message: safeAuthErrorMessage(roleUpdateError),
          });
          return { success: false, error: 'Unable to save your selected account type. Please try again.' };
        }
        if (!roleUpdated) {
          let persistedProfile = null;
          try {
            persistedProfile = await getMyProfile(authUser.id);
          } catch (verificationError) {
            const { code, status } = getAuthErrorMetadata(verificationError);
            console.warn('ArtGuard: Google signup role verification failed after update error.', {
              code: code ?? 'unknown',
              status: status ?? null,
              message: safeAuthErrorMessage(verificationError),
            });
          }
          if (persistedProfile?.role === role) {
            profile = persistedProfile;
          } else {
            console.warn('ArtGuard: Google signup role update was rejected by the database guard.');
            return { success: false, error: 'Unable to save your selected account type. Please try again.' };
          }
        }
        if (roleUpdated) {
          try {
            const savedProfile = await getMyProfile(authUser.id);
            if (!savedProfile || savedProfile.role !== role) {
              console.warn('ArtGuard: Google signup role update was not confirmed.');
              return { success: false, error: 'Unable to verify your selected account type. Please try again.' };
            }
            profile = savedProfile;
          } catch (error) {
            logAuthRequestFailure('oauth', error);
            return { success: false, error: 'Unable to verify your profile update. Check your connection and try again.' };
          }
        }
      }

      const authenticatedUser: AuthUser = {
        ...authUserFromMetadata(authUser),
        name: isNewGoogleAccount ? metadataName ?? '' : profile.name,
        username: profile.username,
        role: profile.role,
        bio: profile.bio ?? undefined,
        interests: profile.interests ?? undefined,
        avatarDataUrl: profile.avatar_data_url ?? undefined,
        onboarded: Boolean(profile.onboarded),
        isPro: Boolean(profile.is_pro),
        lastSeenAt: profile.last_seen_at ?? undefined,
        artistVerificationStatus: profile.artist_verification_status ?? undefined,
        artistVerificationSubmittedAt: profile.artist_verification_submitted_at ?? undefined,
        artistVerificationReviewedAt: profile.artist_verification_reviewed_at ?? undefined,
        artistVerificationReviewedBy: profile.artist_verification_reviewed_by ?? undefined,
        artistVerificationRejectionReason: profile.artist_verification_rejection_reason ?? undefined,
        artistVerificationArtworkId: profile.artist_verification_artwork_id ?? undefined,
        isAdmin: Boolean(profile.is_admin),
      };
      persistSession(authenticatedUser);
      setInitializing(false);
      if (isNewGoogleAccount) storeGoogleNameOnboarding(authUser.id, metadataName ?? '');
      const hasDisplayName = Boolean(profile.name?.trim());
      const hasSavedInterests = Boolean(profile.interests?.length);
      const onboardingComplete = Boolean(profile.onboarded || hasSavedInterests);
      const destination: AuthenticatedDestination = isNewGoogleAccount
        ? isCompletedProfile
          ? '/home'
          : signupStep === 'interests'
          ? '/onboarding/interests'
          : '/onboarding/name'
        : !hasDisplayName || !existingProfile
          ? '/onboarding/name'
          : onboardingComplete
            ? '/home'
            : '/onboarding/interests';
      if ((!isNewGoogleAccount || isCompletedProfile) && onboardingComplete) {
        clearGoogleSignupIntent();
        clearGoogleNameOnboarding();
      }
      return {
        success: true,
        destination,
      };
    } catch (error) {
      logAuthRequestFailure('oauth', error);
      return {
        success: false,
        error: error instanceof TypeError && /fetch|network/i.test(error.message)
          ? 'Unable to connect. Check your connection and try again.'
          : 'Unable to set up your profile. Please try again.',
      };
    }
  }, [persistSession]);

  const requestPasswordReset = useCallback(async (email: string) => {
    if (!isSupabaseConfigured || !supabase) return mockApi.requestPasswordReset(email);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      return error
        ? { success: false, error: 'Could not request a password reset email. Please try again later.' }
        : { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof TypeError && /fetch|network/i.test(error.message)
          ? 'Unable to connect to the password reset service. Check your connection and try again.'
          : 'Could not request a password reset email. Please try again later.',
      };
    }
  }, []);

  const clearPasswordRecoverySession = useCallback(() => {
    setPasswordRecoverySession(false);
  }, []);

  const changeEmail = useCallback(async (email: string) => {
    if (!user) return { success: false, error: 'Not signed in.' };
    const normalizedEmail = email.trim().toLowerCase();

    if (!isSupabaseConfigured || !supabase) {
      const accounts = readAccounts();
      if (accounts.some((account) => account.id !== user.id && account.email.toLowerCase() === normalizedEmail)) {
        return { success: false, error: 'An account with that email already exists.' };
      }
      const result = await mockApi.updateProfile(user.id, { email: normalizedEmail });
      if (result.success && result.user) persistSession(result.user);
      return { success: result.success, error: result.error };
    }

    try {
      const { error } = await supabase.auth.updateUser({ email: normalizedEmail });
      return error ? { success: false, error: error.message } : { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unable to change email.' };
    }
  }, [persistSession, user]);

  const updateProfile = useCallback(async (patch: ProfileUpdatePatch) => {
    if (!user) return { success: false, error: 'Not signed in.' };
    if (!isSupabaseConfigured || !supabase) {
      const result = await mockApi.updateProfile(user.id, patch);
      if (result.success && result.user) persistSession(result.user);
      return { success: result.success, error: result.error };
    }

    const dbPatch = {
      name: patch.name,
      username: patch.username,
      bio: patch.bio,
      interests: patch.interests,
      avatar_data_url: patch.avatarDataUrl,
      onboarded: patch.onboarded,
    };
    const { error } = await supabase.from('profiles').update(dbPatch).eq('id', user.id);
    if (error) return { success: false, error: error.message };
    const { error: metadataError } = await supabase.auth.updateUser({
      data: {
        name: patch.name ?? user.name,
        role: patch.role ?? user.role,
        onboarded: patch.onboarded ?? user.onboarded ?? false,
      },
    });
    if (metadataError) return { success: false, error: metadataError.message };
    const realPatch = { ...patch } as Partial<AuthUser>;
    delete realPatch.isPro;
    const refreshed = { ...user, ...realPatch };
    persistSession(refreshed);
    return { success: true };
  }, [persistSession, user]);

  const enableMockPremium = useCallback(async () => {
    if (!user) return { success: false, error: 'Not signed in.' };
    if (isSupabaseConfigured && supabase) {
      return { success: false, error: 'Premium subscriptions are not available yet.' };
    }
    const result = await mockApi.updateProfile(user.id, { isPro: true });
    if (result.success && result.user) persistSession(result.user);
    return { success: result.success, error: result.error };
  }, [persistSession, user]);

  const deactivateAccount = useCallback(async () => {
    if (!user) return { success: false, error: 'Not signed in.' };
    if (!isSupabaseConfigured || !supabase) {
      return {
        success: false,
        error: 'Account deactivation requires a verified Supabase backend. Demo mode made no changes.',
      };
    }

    try {
      const { error } = await supabase.rpc('deactivate_my_account');
      if (error) return { success: false, error: error.message };

      let warning: string | undefined;
      try {
        const { error: signOutError } = await supabase.auth.signOut({ scope: 'global' });
        if (signOutError) {
          warning = 'Your account is deactivated, but other active sessions could not be revoked. Database access is blocked; contact support if this persists.';
          const { error: localSignOutError } = await supabase.auth.signOut({ scope: 'local' });
          if (localSignOutError) {
            warning = 'Your account is deactivated, but this browser session could not be fully cleared. Close this browser and contact support.';
          }
        }
      } catch (signOutError) {
        console.error('ArtGuard: global session revocation failed after deactivation.', signOutError);
        warning = 'Your account is deactivated, but session revocation could not be confirmed. Database access is blocked; contact support if this persists.';
        try {
          const { error: localSignOutError } = await supabase.auth.signOut({ scope: 'local' });
          if (localSignOutError) {
            warning = 'Your account is deactivated, but this browser session could not be fully cleared. Close this browser and contact support.';
          }
        } catch (localSignOutError) {
          console.error('ArtGuard: local session cleanup failed after deactivation.', localSignOutError);
          warning = 'Your account is deactivated, but this browser session could not be fully cleared. Close this browser and contact support.';
        }
      }

      authStateRevision.current += 1;
      clearPasswordRecoverySession();
      persistSession(null);
      return { success: true, warning };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unable to deactivate this account.',
      };
    }
  }, [clearPasswordRecoverySession, persistSession, user]);

  const requestAccountDeletion = useCallback(async () => {
    if (!user) return { success: false, error: 'Not signed in.' };
    if (!isSupabaseConfigured || !supabase) {
      return {
        success: false,
        error: 'Deletion requests require a verified Supabase backend. Demo mode made no changes.',
      };
    }

    try {
      const { error } = await supabase.rpc('request_my_account_deletion');
      return error
        ? { success: false, error: error.message }
        : { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unable to submit a deletion request.',
      };
    }
  }, [user]);

  const logout = useCallback(() => {
    authStateRevision.current += 1;
    clearPasswordRecoverySession();
    if (isSupabaseConfigured && supabase) void supabase.auth.signOut();
    persistSession(null);
  }, [clearPasswordRecoverySession, persistSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated: !!user,
      initializing,
      sessionRecoveryError,
      retrySessionRecovery,
      backendMode: isSupabaseConfigured ? 'supabase' : 'mock',
      login,
      signUp,
      resendSignupConfirmation,
      completeExistingGoogleLogin,
      completeExistingGoogleEmailLogin,
      startGoogleSignIn,
      completeGoogleSignIn,
      changeEmail,
      deactivateAccount,
      requestAccountDeletion,
      requestPasswordReset,
      passwordRecoverySession,
      clearPasswordRecoverySession,
      updateProfile,
      enableMockPremium,
      logout,
    }),
    [user, initializing, sessionRecoveryError, retrySessionRecovery, login, signUp, resendSignupConfirmation, completeExistingGoogleLogin, completeExistingGoogleEmailLogin, startGoogleSignIn, completeGoogleSignIn, changeEmail, deactivateAccount, requestAccountDeletion, requestPasswordReset, passwordRecoverySession, clearPasswordRecoverySession, updateProfile, enableMockPremium, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
