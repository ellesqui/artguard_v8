import { createClient } from 'npm:@supabase/supabase-js@2';
import { createRemoteJWKSet, jwtVerify } from 'npm:jose@5';

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const PAGE_SIZE = 1000;
const LOCAL_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:5175',
];

function allowedOrigins(): Set<string> {
  const configuredOrigins = Deno.env.get('ARTGUARD_ALLOWED_ORIGINS')
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];
  return new Set([...LOCAL_ORIGINS, ...configuredOrigins]);
}

function jsonResponse(
  body: Record<string, string>,
  status: number,
  origin: string,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Access-Control-Expose-Headers': 'Retry-After',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      Vary: 'Origin',
    },
  });
}

function credentialFailureStage(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'jwt_invalid';
  const details = error as Record<string, unknown>;
  const code = typeof details.code === 'string' ? details.code : '';
  const claim = typeof details.claim === 'string' ? details.claim : '';

  if (code === 'ERR_JWT_EXPIRED') return 'expired_token';
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && claim === 'aud') return 'audience_mismatch';
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && claim === 'iss') return 'invalid_issuer';
  if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' || code === 'ERR_JWKS_NO_MATCHING_KEY') {
    return 'signature_invalid';
  }
  if (code.startsWith('ERR_JWKS_') || code === 'ERR_JOSE_ALG_NOT_ALLOWED') {
    return 'key_or_algorithm_verification_failed';
  }
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && claim === 'sub') return 'missing_subject';
  return 'jwt_invalid';
}

async function fingerprint(value: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 12);
  } catch {
    return 'unavailable';
  }
}

async function unverifiedAudienceFingerprints(token: string): Promise<string[]> {
  try {
    const payloadSegment = token.split('.')[1];
    if (!payloadSegment) return [];
    const base64 = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))) as {
      aud?: unknown;
    };
    const audiences = typeof payload.aud === 'string'
      ? [payload.aud]
      : Array.isArray(payload.aud)
        ? payload.aud.filter((audience): audience is string => typeof audience === 'string')
        : [];
    return Promise.all(audiences.map(fingerprint));
  } catch {
    return [];
  }
}

async function verifiedAudienceFingerprints(audience: unknown): Promise<string[]> {
  const audiences = typeof audience === 'string'
    ? [audience]
    : Array.isArray(audience)
      ? audience.filter((value): value is string => typeof value === 'string')
      : [];
  return Promise.all(audiences.map(fingerprint));
}

type AdminIdentityShape = {
  id?: string;
  identity_id?: string;
  identity_data?: Record<string, unknown>;
  provider?: string;
  provider_id?: string;
};

function providerAccountId(identity: AdminIdentityShape): string | undefined {
  if (Object.hasOwn(identity, 'provider_id')) {
    return typeof identity.provider_id === 'string' ? identity.provider_id : undefined;
  }
  return typeof identity.id === 'string' ? identity.id : undefined;
}

function findGoogleIdentity(identity: AdminIdentityShape, subject: string): boolean {
  return identity.provider === 'google' && providerAccountId(identity) === subject;
}

async function findExistingGoogleUser(
  admin: ReturnType<typeof createClient>,
  email: string,
  subject: string,
) {
  let candidateCount = 0;
  for (let page = 1; ; page += 1) {
    let result: Awaited<ReturnType<typeof admin.auth.admin.listUsers>>;
    try {
      result = await admin.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    } catch {
      console.error('google-login: Auth Admin API request failed.', {
        stage: 'auth_admin_list_users_error',
        page,
      });
      throw new Error('Auth Admin API request failed.');
    }
    if (result.error) {
      console.error('google-login: Auth Admin API request failed.', {
        stage: 'auth_admin_list_users_error',
        page,
      });
      throw result.error;
    }

    for (const candidate of result.data.users) {
      if (candidate.email?.trim().toLowerCase() !== email) continue;
      candidateCount += 1;
      let specificUserResult: Awaited<ReturnType<typeof admin.auth.admin.getUserById>>;
      try {
        specificUserResult = await admin.auth.admin.getUserById(candidate.id);
      } catch {
        console.error('google-login: Specific Auth user lookup failed.', {
          stage: 'auth_admin_get_user_by_id_error',
        });
        throw new Error('Specific Auth user lookup failed.');
      }
      if (specificUserResult.error) {
        console.error('google-login: Specific Auth user lookup failed.', {
          stage: 'auth_admin_get_user_by_id_error',
        });
        throw specificUserResult.error;
      }

      const user = specificUserResult.data.user;
      if (!user) continue;
      const googleIdentities = (user.identities ?? []).filter((identity) => identity.provider === 'google');
      const matched = googleIdentities.some((identity) => findGoogleIdentity(identity, subject));
      console.info('google-login: Google identity match result.', {
        stage: matched ? 'google_identity_match_found' : 'google_identity_match_not_found',
        candidateCount,
      });
      if (matched) return user;
    }

    if (result.data.users.length < PAGE_SIZE) break;
  }
  console.info('google-login: Auth user candidate lookup completed.', {
    stage: 'auth_user_candidate_lookup_completed',
    outcome: candidateCount > 0 ? 'google_identity_not_matched' : 'candidate_not_found',
    candidateCount,
  });
  return null;
}

async function findProfile(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<{ id: string; role: string } | null> {
  let profile: { id: string; role: string } | null;
  try {
    const result = await admin
      .from('profiles')
      .select('id, role')
      .eq('id', userId)
      .maybeSingle();
    if (result.error) throw result.error;
    profile = result.data;
  } catch {
    console.error('google-login: Profile query failed.', {
      stage: 'profile_query_error',
    });
    throw new Error('Profile query failed.');
  }

  if (!profile) {
    console.info('google-login: Profile row not found.', {
      stage: 'profile_row_not_found',
    });
    return null;
  }
  console.info('google-login: Profile row found.', {
    stage: 'profile_row_found',
  });

  if (profile.role !== 'artist' && profile.role !== 'client') {
    console.warn('google-login: Profile role is invalid.', {
      stage: 'profile_role_invalid',
    });
    return profile;
  }
  console.info('google-login: Profile role is valid.', {
    stage: 'profile_role_valid',
  });
  return profile;
}

export async function handleGoogleLoginExisting(request: Request): Promise<Response> {
  const origin = request.headers.get('Origin') ?? '';
  if (!allowedOrigins().has(origin)) {
    return new Response(null, { status: 403, headers: { Vary: 'Origin' } });
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Max-Age': '86400',
        'Access-Control-Expose-Headers': 'Retry-After',
        'Cache-Control': 'no-store',
        Vary: 'Origin',
      },
    });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, origin);
  }

  try {
    const googleClientId = Deno.env.get('GOOGLE_CLIENT_ID')?.trim();
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!googleClientId) {
      console.error('google-login: credential rejected.', { stage: 'google_client_id_missing' });
      return jsonResponse({ error: 'Unable to verify Google sign-in.', code: 'google_client_id_missing' }, 500, origin);
    }
    if (!supabaseUrl || !serviceRoleKey) {
      console.error('google-login: server configuration is incomplete.', { stage: 'supabase_configuration_missing' });
      return jsonResponse({ error: 'Unable to complete Google sign-in.' }, 500, origin);
    }

    const bodyText = await request.text();
    if (bodyText.length > 16_384) {
      console.warn('google-login: credential rejected.', { stage: 'request_too_large' });
      return jsonResponse({ error: 'Invalid request.' }, 400, origin);
    }
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      console.warn('google-login: credential rejected.', { stage: 'invalid_request_json' });
      return jsonResponse({ error: 'Invalid request.' }, 400, origin);
    }
    const credential = typeof body === 'object' && body !== null && 'credential' in body
      ? body.credential
      : undefined;
    if (typeof credential !== 'string' || credential.length === 0) {
      console.warn('google-login: credential rejected.', { stage: 'missing_credential' });
      return jsonResponse({ error: 'Invalid Google credential.', code: 'missing_credential' }, 401, origin);
    }
    if (credential.length < 20 || credential.length > 12_000) {
      console.warn('google-login: credential rejected.', { stage: 'credential_malformed' });
      return jsonResponse({ error: 'Invalid Google credential.', code: 'credential_malformed' }, 401, origin);
    }

    let claims;
    try {
      ({ payload: claims } = await jwtVerify(credential, GOOGLE_JWKS, {
        algorithms: ['RS256'],
        audience: googleClientId,
        issuer: GOOGLE_ISSUERS,
      }));
    } catch (error) {
      const stage = credentialFailureStage(error);
      if (stage === 'audience_mismatch') {
        const expectedClientIdFingerprint = await fingerprint(googleClientId);
        const unverifiedTokenAudienceFingerprints = await unverifiedAudienceFingerprints(credential);
        console.warn(`[AG GoogleAudienceDiag] ${JSON.stringify({
          stage,
          expectedClientIdFingerprint,
          tokenAudienceTrust: 'unverified_diagnostic_only',
          unverifiedTokenAudienceFingerprints,
        })}`);
      } else {
        console.warn('google-login: credential rejected.', { stage });
      }
      return jsonResponse({ error: 'Invalid Google credential.', code: stage }, 401, origin);
    }

    console.info(`[AG GoogleAudienceDiag] ${JSON.stringify({
      stage: 'jwt_verified',
      expectedClientIdFingerprint: await fingerprint(googleClientId),
      verifiedTokenAudienceFingerprints: await verifiedAudienceFingerprints(claims.aud),
    })}`);

    const subject = typeof claims.sub === 'string' ? claims.sub : '';
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (!subject) {
      console.warn('google-login: credential rejected.', { stage: 'missing_subject' });
      return jsonResponse({ error: 'Invalid Google credential.', code: 'missing_subject' }, 401, origin);
    }
    if (!email) {
      console.warn('google-login: credential rejected.', { stage: 'missing_email' });
      return jsonResponse({ error: 'Invalid Google credential.', code: 'missing_email' }, 401, origin);
    }
    if (claims.email_verified !== true) {
      console.warn('google-login: credential rejected.', { stage: 'email_not_verified' });
      return jsonResponse({ error: 'Invalid Google credential.', code: 'email_not_verified' }, 401, origin);
    }
    console.info('google-login: Google token verified.', {
      stage: 'google_token_verified',
    });

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
    let user: Awaited<ReturnType<typeof findExistingGoogleUser>>;
    try {
      user = await findExistingGoogleUser(admin, email, subject);
    } catch {
      return jsonResponse({ error: 'Unable to complete Google sign-in.' }, 500, origin);
    }
    if (!user || !user.email) {
      return jsonResponse({ code: 'account_not_found' }, 404, origin);
    }

    let profile: { id: string; role: string } | null;
    try {
      profile = await findProfile(admin, user.id);
    } catch {
      return jsonResponse({ error: 'Unable to complete Google sign-in.' }, 500, origin);
    }
    if (!profile || (profile.role !== 'artist' && profile.role !== 'client')) {
      return jsonResponse({ code: 'account_not_found' }, 404, origin);
    }

    console.info('google-login: Existing Google account verified.', {
      stage: 'existing_google_account_verified',
    });
    return jsonResponse({ accepted: 'true' }, 200, origin);
  } catch {
    console.error('google-login: request failed.');
    return jsonResponse({ error: 'Unable to complete Google sign-in.' }, 500, origin);
  }
}
