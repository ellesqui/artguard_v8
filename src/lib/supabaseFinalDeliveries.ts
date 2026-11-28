import { supabase, supabasePublishableKey, supabaseUrl } from './supabase';
import type { FinalDeliveryMimeType } from './finalDeliveryWorkflow';

export const FINAL_DELIVERY_BUCKET = 'commission-final-deliveries';

export type FinalDeliveryStatus =
  | 'UPLOADING'
  | 'AWAITING_CLIENT_REVIEW'
  | 'REVISION_REQUESTED'
  | 'ACCEPTED'
  | 'ABANDONED';

export interface FinalDeliveryFile {
  file_id: string;
  filename: string;
  mime_type: FinalDeliveryMimeType;
  size_bytes: number;
}

export interface FinalDelivery {
  delivery_id: string;
  attempt_number: number;
  status: FinalDeliveryStatus;
  is_current: boolean;
  submitted_at: string | null;
  decided_at: string | null;
  revision_reason: string | null;
  files: FinalDeliveryFile[];
}

interface ReservedFinalDeliveryFile {
  file_id: string;
  filename: string;
}

interface BeginFinalDeliveryResult {
  delivery_id: string;
  attempt_number: number;
  files: ReservedFinalDeliveryFile[];
  expires_at: string;
}

interface SignedFinalDeliveryUpload {
  path: string;
  token: string;
}

interface DownloadedFinalDeliveryFile {
  blob: Blob;
  filename: string;
  mimeType: FinalDeliveryMimeType;
}

function requireSupabase() {
  if (!supabase) throw new Error('Supabase is not configured.');
  return supabase;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBeginResult(data: unknown): BeginFinalDeliveryResult {
  if (!isRecord(data) || typeof data.delivery_id !== 'string'
    || !Number.isInteger(data.attempt_number)
    || typeof data.expires_at !== 'string'
    || !Array.isArray(data.files)) {
    throw new Error('Final Delivery upload reservation was incomplete.');
  }

  const files = data.files.filter((file): file is ReservedFinalDeliveryFile =>
    isRecord(file) && typeof file.file_id === 'string' && typeof file.filename === 'string');
  if (files.length !== data.files.length || files.length === 0) {
    throw new Error('Final Delivery upload reservation did not include every file.');
  }

  return {
    delivery_id: data.delivery_id,
    attempt_number: data.attempt_number as number,
    expires_at: data.expires_at,
    files,
  };
}

function readUploadUrl(data: unknown): SignedFinalDeliveryUpload {
  if (!isRecord(data) || typeof data.path !== 'string' || typeof data.token !== 'string') {
    throw new Error('The protected upload URL was incomplete.');
  }
  return { path: data.path, token: data.token };
}

function safeDownloadFilename(value: string | null): string {
  const filename = value?.match(/filename="([^"]*)"/i)?.[1]
    ?.replace(/[\r\n"\\/]/g, '_')
    .replace(/[^\x20-\x7e]/g, '_')
    .slice(0, 180);
  return filename || 'final-delivery-file';
}

function readDownloadError(text: string, status: number): string {
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body) && typeof body.error === 'string') return body.error;
  } catch {
    // Keep the explicit HTTP status when the function returns a plain-text error.
  }
  return `Could not retrieve Final Delivery file (${status}).`;
}

export async function listFinalDeliveries(commissionId: string): Promise<FinalDelivery[]> {
  const client = requireSupabase();
  const { data, error } = await client.rpc('list_commission_final_deliveries', {
    p_commission_id: commissionId,
  });
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('Final Delivery history was not returned.');
  return data as FinalDelivery[];
}

export async function beginFinalDelivery(
  commissionId: string,
  files: readonly File[],
): Promise<BeginFinalDeliveryResult> {
  const client = requireSupabase();
  const { data, error } = await client.rpc('begin_commission_final_delivery', {
    p_commission_id: commissionId,
    p_files: files.map((file) => ({
      filename: file.name,
      mime_type: file.type,
      size_bytes: file.size,
    })),
  });
  if (error) throw error;
  return readBeginResult(data);
}

export async function uploadFinalDeliveryFile(deliveryId: string, fileId: string, file: File): Promise<void> {
  const client = requireSupabase();
  const { data, error } = await client.functions.invoke('final-delivery-storage', {
    body: { action: 'upload-url', deliveryId, fileId },
  });
  if (error) throw error;
  const upload = readUploadUrl(data);
  const { error: uploadError } = await client.storage
    .from(FINAL_DELIVERY_BUCKET)
    .uploadToSignedUrl(upload.path, upload.token, file, {
      contentType: file.type,
      upsert: false,
    });
  if (uploadError) throw uploadError;
}

export async function verifyAndSubmitFinalDelivery(deliveryId: string): Promise<void> {
  const client = requireSupabase();
  const { data, error } = await client.functions.invoke('final-delivery-storage', {
    body: { action: 'verify-submit', deliveryId },
  });
  if (isRecord(data) && typeof data.error === 'string') {
    const retryable = data.retryable === true;
    throw new Error(retryable
      ? 'Submission could not be confirmed yet. Retry submission once; your uploaded files remain reserved.'
      : data.error);
  }
  if (error) throw new Error('Final Delivery submission could not be confirmed.');
  if (!isRecord(data) || data.status !== 'AWAITING_CLIENT_REVIEW') {
    throw new Error('Final Delivery submission could not be confirmed.');
  }
}

export async function acceptFinalDelivery(deliveryId: string): Promise<void> {
  const { error } = await requireSupabase().rpc('accept_commission_final_delivery', {
    p_delivery_id: deliveryId,
  });
  if (error) throw error;
}

export async function requestFinalDeliveryRevision(deliveryId: string, reason: string): Promise<void> {
  const { error } = await requireSupabase().rpc('request_commission_final_revision', {
    p_delivery_id: deliveryId,
    p_reason: reason,
  });
  if (error) throw error;
}

export async function downloadFinalDeliveryFile(fileId: string): Promise<DownloadedFinalDeliveryFile> {
  const client = requireSupabase();
  if (!supabaseUrl || !supabasePublishableKey) throw new Error('Protected file access is not configured.');
  const { data, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error('Sign in again before accessing Final Delivery files.');

  const response = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/functions/v1/final-delivery-storage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: supabasePublishableKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'download', fileId }),
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(readDownloadError(await response.text(), response.status));
  }

  const mimeType = response.headers.get('Content-Type');
  if (mimeType !== 'image/jpeg' && mimeType !== 'image/png' && mimeType !== 'application/pdf') {
    throw new Error('The protected file returned an unsupported media type.');
  }
  const blob = await response.blob();
  if (blob.size === 0) throw new Error('The protected Final Delivery file was empty.');

  return {
    blob,
    filename: safeDownloadFilename(response.headers.get('Content-Disposition')),
    mimeType,
  };
}
