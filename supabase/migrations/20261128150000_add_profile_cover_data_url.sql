-- Add a dedicated profile cover photo field, separate from avatar_data_url.
-- Existing profile RLS policies continue to restrict writes to the profile owner.
alter table public.profiles
  add column if not exists cover_data_url text;

notify pgrst, 'reload schema';
