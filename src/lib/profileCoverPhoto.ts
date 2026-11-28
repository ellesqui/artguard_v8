const MAX_COVER_PHOTO_SIZE_BYTES = 2 * 1024 * 1024;
const ALLOWED_COVER_PHOTO_TYPES = new Set(['image/jpeg', 'image/png']);

export function readCoverPhotoDataUrl(file: File): Promise<string> {
  if (!ALLOWED_COVER_PHOTO_TYPES.has(file.type)) {
    return Promise.reject(new Error('Choose a JPG or PNG image.'));
  }
  if (file.size === 0 || file.size > MAX_COVER_PHOTO_SIZE_BYTES) {
    return Promise.reject(new Error('Cover photos must be 2 MB or less.'));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Could not read that cover photo.'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read that cover photo.'));
    reader.readAsDataURL(file);
  });
}
