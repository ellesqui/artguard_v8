const MAX_COVER_PHOTO_SIZE_BYTES = 2 * 1024 * 1024;
const ALLOWED_COVER_PHOTO_TYPES = new Set(['image/jpeg', 'image/png']);

export function validateCoverPhotoFile(file: File): void {
  if (!ALLOWED_COVER_PHOTO_TYPES.has(file.type)) {
    throw new Error('Choose a JPG or PNG image.');
  }
  if (file.size === 0 || file.size > MAX_COVER_PHOTO_SIZE_BYTES) {
    throw new Error('Cover photos must be 2 MB or less.');
  }
}
