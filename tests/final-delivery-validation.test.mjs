import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectFinalDeliveryMimeType,
  safeFinalDeliveryFilename,
  verifyFinalDeliveryFile,
} from '../supabase/functions/_shared/finalDeliveryValidation.ts';

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pdf = new TextEncoder().encode('%PDF-1.7\n');

test('detects only the supported Final Delivery file signatures', () => {
  assert.equal(detectFinalDeliveryMimeType(jpeg), 'image/jpeg');
  assert.equal(detectFinalDeliveryMimeType(png), 'image/png');
  assert.equal(detectFinalDeliveryMimeType(pdf), 'application/pdf');
  assert.equal(detectFinalDeliveryMimeType(new TextEncoder().encode('not a file')), null);
});

test('verifies actual signatures, MIME agreement, size, and cryptographic hash', async () => {
  const verified = await verifyFinalDeliveryFile(jpeg, 'image/jpeg', jpeg.length);
  assert.equal(verified.mimeType, 'image/jpeg');
  assert.equal(verified.sizeBytes, jpeg.length);
  assert.match(verified.sha256, /^[0-9a-f]{64}$/);

  await assert.rejects(verifyFinalDeliveryFile(jpeg, 'image/png', jpeg.length), /signature does not match/i);
  await assert.rejects(verifyFinalDeliveryFile(new Uint8Array(), 'image/jpeg', 0), /between 1 byte/i);
  await assert.rejects(
    verifyFinalDeliveryFile(new Uint8Array(40 * 1024 * 1024 + 1), 'image/jpeg', null),
    /between 1 byte/i,
  );
  await assert.rejects(verifyFinalDeliveryFile(jpeg, 'image/jpeg', jpeg.length + 1), /size does not match/i);
});

test('sanitizes filenames used in protected download headers', () => {
  assert.equal(safeFinalDeliveryFilename('art\r\nX-Injected: yes".pdf'), 'art__X-Injected: yes_.pdf');
  assert.equal(safeFinalDeliveryFilename(''), 'final-delivery-file');
});
