export const FINAL_DELIVERY_MAX_FILE_BYTES = 40 * 1024 * 1024;

export const FINAL_DELIVERY_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
] as const;

export type FinalDeliveryMimeType = (typeof FINAL_DELIVERY_MIME_TYPES)[number];

export interface VerifiedFinalDeliveryFile {
  mimeType: FinalDeliveryMimeType;
  sizeBytes: number;
  sha256: string;
}

export function detectFinalDeliveryMimeType(bytes: Uint8Array): FinalDeliveryMimeType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= pngSignature.length
    && pngSignature.every((byte, index) => bytes[index] === byte)) {
    return 'image/png';
  }

  const pdfSignature = new TextEncoder().encode('%PDF-');
  if (bytes.length >= pdfSignature.length
    && pdfSignature.every((byte, index) => bytes[index] === byte)) {
    return 'application/pdf';
  }

  return null;
}

export async function verifyFinalDeliveryFile(
  bytes: Uint8Array,
  declaredMimeType: string,
  clientReportedSizeBytes: number | null,
): Promise<VerifiedFinalDeliveryFile> {
  if (bytes.length === 0 || bytes.length > FINAL_DELIVERY_MAX_FILE_BYTES) {
    throw new Error('Final Delivery files must be between 1 byte and 40 MiB.');
  }

  const mimeType = detectFinalDeliveryMimeType(bytes);
  if (!mimeType) throw new Error('Unsupported or invalid Final Delivery file signature.');
  if (mimeType !== declaredMimeType) {
    throw new Error('The uploaded file signature does not match its declared media type.');
  }
  if (clientReportedSizeBytes !== null && clientReportedSizeBytes !== bytes.length) {
    throw new Error('The uploaded file size does not match its reserved metadata.');
  }

  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { mimeType, sizeBytes: bytes.length, sha256 };
}

export function safeFinalDeliveryFilename(filename: string): string {
  const safe = filename
    .replace(/[\r\n"]/g, '_')
    .replace(/[\\/]/g, '_')
    .replace(/[^\x20-\x7e]/g, '_')
    .slice(0, 180);
  return safe || 'final-delivery-file';
}
