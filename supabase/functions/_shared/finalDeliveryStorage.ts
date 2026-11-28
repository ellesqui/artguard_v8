import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  safeFinalDeliveryFilename,
  verifyFinalDeliveryFile,
} from './finalDeliveryValidation.ts';

const BUCKET = 'commission-final-deliveries';
const UPLOAD_CUTOFF_ERROR_CODE = 'FINAL_DELIVERY_UPLOAD_CUTOFF:';
const UPLOAD_CUTOFF_MESSAGE =
  'New upload links are available only when more than three hours remain in the reservation.';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:5175',
]);

interface UploadTarget {
  file_id: string;
  storage_path: string;
  display_filename: string;
  declared_mime_type: string;
  client_reported_size_bytes: number | null;
}

interface DownloadTarget {
  storage_path: string;
  display_filename: string;
  mime_type: string;
}

function allowedOrigins(): Set<string> {
  const configured = Deno.env.get('ARTGUARD_ALLOWED_ORIGINS')
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];
  return new Set([...LOCAL_ORIGINS, ...configured]);
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  origin: string | null,
): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    headers.set('Access-Control-Max-Age', '86400');
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function getServiceClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) throw new Error('Final Delivery storage service is not configured.');
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function authenticatedActor(request: Request) {
  const authorization = request.headers.get('Authorization');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!authorization || !supabaseUrl || !anonKey) return null;
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) return null;
  return { user: data.user, client: userClient };
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function getArray<T>(data: unknown): T[] {
  return Array.isArray(data) ? data as T[] : [];
}

async function getUploadTargets(
  admin: ReturnType<typeof getServiceClient>,
  deliveryId: string,
  actorId: string,
): Promise<UploadTarget[]> {
  const { data, error } = await admin.rpc('get_final_delivery_upload_targets', {
    p_delivery_id: deliveryId,
    p_actor_id: actorId,
  });
  if (error?.message.startsWith(UPLOAD_CUTOFF_ERROR_CODE)) {
    throw new Error(UPLOAD_CUTOFF_MESSAGE);
  }
  if (error) throw new Error('Unable to verify Final Delivery upload authorization.');
  return getArray<UploadTarget>(data);
}

async function getVerificationTargets(
  admin: ReturnType<typeof getServiceClient>,
  deliveryId: string,
  actorId: string,
): Promise<UploadTarget[]> {
  const { data, error } = await admin.rpc('get_final_delivery_verification_targets', {
    p_delivery_id: deliveryId,
    p_actor_id: actorId,
  });
  if (error) throw new Error('Unable to verify Final Delivery submission authorization.');
  return getArray<UploadTarget>(data);
}

function permanentFinalizationError(message: string): boolean {
  const permanentMarkers = [
    'expired',
    'not eligible',
    'only the',
    'approved',
    'every reserved',
    'verified file',
    'manifest',
    'metadata is invalid',
    'already awaiting review',
  ];
  const normalized = message.toLowerCase();
  return permanentMarkers.some((marker) => normalized.includes(marker));
}

function safeFinalizationLog(error: {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}, stateError?: {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}): Record<string, string | undefined> {
  return {
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
    ...(stateError ? {
      state_error_code: stateError.code,
      state_error_message: stateError.message,
      state_error_details: stateError.details,
      state_error_hint: stateError.hint,
    } : {}),
  };
}

async function cleanAbandonedUpload(
  admin: ReturnType<typeof getServiceClient>,
  deliveryId: string,
  actorId: string,
  paths: string[],
): Promise<boolean> {
  const { error: abandonError } = await admin.rpc('abandon_commission_final_delivery_upload', {
    p_delivery_id: deliveryId,
    p_actor_id: actorId,
  });
  if (abandonError) {
    console.error('Unable to abandon invalid Final Delivery upload.', abandonError.message);
    return false;
  }

  if (paths.length > 0) {
    const { error: removeError } = await admin.storage.from(BUCKET).remove(paths);
    if (removeError) {
      console.error('Unable to remove abandoned Final Delivery objects.', removeError.message);
      return false;
    }
  }

  const { error: completeError } = await admin.rpc('complete_final_delivery_storage_cleanup', {
    p_delivery_id: deliveryId,
  });
  if (completeError) {
    console.error('Unable to record Final Delivery object cleanup.', completeError.message);
    return false;
  }
  return true;
}

async function handleUploadUrl(
  admin: ReturnType<typeof getServiceClient>,
  userClient: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
  actorId: string,
  origin: string | null,
): Promise<Response> {
  if (!validUuid(body.deliveryId) || !validUuid(body.fileId)) {
    return jsonResponse({ error: 'Invalid Final Delivery file request.' }, 400, origin);
  }
  let targets: UploadTarget[];
  try {
    targets = await getUploadTargets(admin, body.deliveryId, actorId);
  } catch (error) {
    if (error instanceof Error && error.message === UPLOAD_CUTOFF_MESSAGE) {
      return jsonResponse({ error: error.message }, 409, origin);
    }
    throw error;
  }
  const target = targets.find((file) => file.file_id === body.fileId);
  if (!target) return jsonResponse({ error: 'Final Delivery file is not available for upload.' }, 404, origin);

  const { data, error } = await userClient.storage.from(BUCKET).createSignedUploadUrl(
    target.storage_path,
    { upsert: false },
  );
  if (error || !data) {
    console.error('Unable to create Final Delivery upload URL.', error?.message);
    return jsonResponse({ error: 'Unable to prepare the protected upload.' }, 502, origin);
  }
  return jsonResponse({
    path: data.path,
    token: data.token,
    signedUrl: data.signedUrl,
  }, 200, origin);
}

async function handleVerifySubmit(
  admin: ReturnType<typeof getServiceClient>,
  body: Record<string, unknown>,
  actorId: string,
  origin: string | null,
): Promise<Response> {
  if (!validUuid(body.deliveryId)) {
    return jsonResponse({ error: 'Invalid Final Delivery batch.' }, 400, origin);
  }
  const targets = await getVerificationTargets(admin, body.deliveryId, actorId);
  if (targets.length === 0) {
    return jsonResponse({ error: 'No reserved files are available for this upload.' }, 409, origin);
  }

  const verifiedFiles: Array<{
    file_id: string;
    mime_type: string;
    size_bytes: number;
    sha256: string;
  }> = [];
  try {
    for (const target of targets) {
      const { data, error } = await admin.storage.from(BUCKET).download(target.storage_path);
      if (error || !data) throw new Error('An expected uploaded object is missing.');
      const bytes = new Uint8Array(await data.arrayBuffer());
      const verified = await verifyFinalDeliveryFile(
        bytes,
        target.declared_mime_type,
        target.client_reported_size_bytes,
      );
      verifiedFiles.push({
        file_id: target.file_id,
        mime_type: verified.mimeType,
        size_bytes: verified.sizeBytes,
        sha256: verified.sha256,
      });
    }
  } catch (error) {
    const cleaned = await cleanAbandonedUpload(
      admin,
      body.deliveryId,
      actorId,
      targets.map((target) => target.storage_path),
    );
    if (!cleaned) {
      return jsonResponse({
        error: 'Final Delivery validation failed; cleanup is pending.',
      }, 500, origin);
    }
    return jsonResponse({
      error: error instanceof Error ? error.message : 'Final Delivery validation failed.',
    }, 422, origin);
  }

  const { data, error } = await admin.rpc('finalize_commission_final_delivery', {
    p_delivery_id: body.deliveryId,
    p_actor_id: actorId,
    p_verified_files: verifiedFiles,
  });
  if (error) {
    const { data: stateData, error: stateError } = await admin.rpc('get_final_delivery_batch_state', {
      p_delivery_id: body.deliveryId,
      p_actor_id: actorId,
    });
    console.error('Final Delivery finalization RPC failed.', safeFinalizationLog(error, stateError ?? undefined));
    const state = getArray<{ status: string; is_current: boolean }>(stateData)[0];
    if (!stateError && state?.status === 'AWAITING_CLIENT_REVIEW' && state.is_current) {
      return jsonResponse({ status: state.status }, 200, origin);
    }
    if (!stateError && state?.status === 'UPLOADING') {
      if (!permanentFinalizationError(error.message)) {
        return jsonResponse({
          error: 'Submission could not be confirmed yet. Your files remain reserved; retry submission once.',
          retryable: true,
        }, 503, origin);
      }
      const cleaned = await cleanAbandonedUpload(
        admin,
        body.deliveryId,
        actorId,
        targets.map((target) => target.storage_path),
      );
      if (!cleaned) {
        return jsonResponse({ error: 'Submission failed; cleanup is pending.' }, 500, origin);
      }
      return jsonResponse({ error: 'Final Delivery could not be submitted.' }, 409, origin);
    }
    console.error('Final Delivery submission result could not be confirmed.', error.message, stateError?.message);
    return jsonResponse({ error: 'Final Delivery submission status could not be confirmed.' }, 503, origin);
  }

  return jsonResponse({ status: data?.status ?? 'AWAITING_CLIENT_REVIEW' }, 200, origin);
}

async function handleDownload(
  admin: ReturnType<typeof getServiceClient>,
  body: Record<string, unknown>,
  actorId: string,
  origin: string | null,
): Promise<Response> {
  const baseHeaders = new Headers({
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  });
  if (origin) {
    baseHeaders.set('Access-Control-Allow-Origin', origin);
    baseHeaders.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type');
  }
  if (!validUuid(body.fileId)) return new Response('Not found', { status: 404, headers: baseHeaders });
  const { data, error } = await admin.rpc('get_final_delivery_download_target', {
    p_file_id: body.fileId,
    p_actor_id: actorId,
  });
  const target = getArray<DownloadTarget>(data)[0];
  if (error || !target) return new Response('Not found', { status: 404, headers: baseHeaders });

  const { data: file, error: downloadError } = await admin.storage.from(BUCKET).download(target.storage_path);
  if (downloadError || !file) {
    console.error('Unable to retrieve protected Final Delivery file.', downloadError?.message);
    return new Response('Unable to retrieve file', { status: 502, headers: baseHeaders });
  }

  const disposition = target.mime_type.startsWith('image/') ? 'inline' : 'attachment';
  return new Response(file, {
    status: 200,
    headers: new Headers({
      ...Object.fromEntries(baseHeaders.entries()),
      'Content-Disposition': `${disposition}; filename="${safeFinalDeliveryFilename(target.display_filename)}"`,
      'Content-Length': String(file.size),
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Type': target.mime_type,
    }),
  });
}

export async function handleFinalDeliveryStorage(request: Request): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') {
    if (!origin || !allowedOrigins().has(origin)) {
      return jsonResponse({ error: 'Origin is not allowed.' }, 403, null);
    }
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      },
    });
  }
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405, null);
  if (origin && !allowedOrigins().has(origin)) {
    return jsonResponse({ error: 'Origin is not allowed.' }, 403, null);
  }

  const actorContext = await authenticatedActor(request);
  if (!actorContext) return jsonResponse({ error: 'Authentication required.' }, 401, origin);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return jsonResponse({ error: 'Invalid request body.' }, 400, origin);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: 'Invalid request body.' }, 400, origin);
  }

  const admin = getServiceClient();
  try {
    if (body.action === 'upload-url') {
      return await handleUploadUrl(admin, actorContext.client, body, actorContext.user.id, origin);
    }
    if (body.action === 'verify-submit') {
      return await handleVerifySubmit(admin, body, actorContext.user.id, origin);
    }
    if (body.action === 'download') {
      return await handleDownload(admin, body, actorContext.user.id, origin);
    }
    return jsonResponse({ error: 'Unsupported Final Delivery action.' }, 400, origin);
  } catch (error) {
    console.error('Final Delivery storage request failed.', error);
    return jsonResponse({ error: 'Final Delivery storage request failed.' }, 500, origin);
  }
}
