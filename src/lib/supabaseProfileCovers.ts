import { supabase } from './supabase';
import { validateCoverPhotoFile } from './profileCoverPhoto';

const PROFILE_COVERS_BUCKET = 'profile-covers';
const PROFILE_COVER_PATH_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$/i;

function assertProfileCoverPath(path: string, ownerId?: string): void {
  if (!PROFILE_COVER_PATH_PATTERN.test(path) || (ownerId && !path.startsWith(`${ownerId}/`))) {
    throw new Error('Invalid profile cover image path.');
  }
}

export async function uploadProfileCoverObject(ownerId: string, file: File): Promise<string> {
  if (!supabase) throw new Error('Supabase is not configured.');
  validateCoverPhotoFile(file);
  if (!/^[0-9a-f-]{36}$/i.test(ownerId)) throw new Error('Invalid profile owner.');

  const extension = file.type === 'image/png' ? 'png' : 'jpg';
  const path = `${ownerId}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from(PROFILE_COVERS_BUCKET).upload(path, file, {
    cacheControl: '3600',
    contentType: file.type,
    upsert: false,
  });
  if (error) throw error;
  return path;
}

export async function createProfileCoverSignedUrl(path: string): Promise<string> {
  if (!supabase) throw new Error('Supabase is not configured.');
  assertProfileCoverPath(path);
  const { data, error } = await supabase.storage.from(PROFILE_COVERS_BUCKET).createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}

export async function deleteProfileCoverObject(path: string, ownerId: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured.');
  assertProfileCoverPath(path, ownerId);
  const { error } = await supabase.storage.from(PROFILE_COVERS_BUCKET).remove([path]);
  if (error) throw error;
}
