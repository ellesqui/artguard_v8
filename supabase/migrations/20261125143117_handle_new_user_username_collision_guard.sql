CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_name text;
  v_role text;
  v_base_username text;
  v_candidate_username text;
BEGIN
  -- Preserve an existing profile if this trigger is retried for the same Auth user.
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = NEW.id) THEN
    RETURN NEW;
  END IF;

  v_name := COALESCE(
    NULLIF(BTRIM(NEW.raw_user_meta_data ->> 'name'), ''),
    NULLIF(SPLIT_PART(COALESCE(NEW.email, ''), '@', 1), ''),
    'User'
  );

  -- Never trust arbitrary user metadata for a profile role.
  v_role := CASE
    WHEN NEW.raw_user_meta_data ->> 'role' IN ('artist', 'client')
      THEN NEW.raw_user_meta_data ->> 'role'
    ELSE 'client'
  END;

  v_base_username := COALESCE(
    NULLIF(
      LOWER(
        REGEXP_REPLACE(
          SPLIT_PART(COALESCE(NEW.email, ''), '@', 1),
          '[^a-zA-Z0-9._-]+',
          '',
          'g'
        )
      ),
      ''
    ),
    'user'
  );

  -- Prefer the readable email-derived username when it is available.
  INSERT INTO public.profiles (id, name, username, role)
  VALUES (NEW.id, v_name, v_base_username, v_role)
  ON CONFLICT DO NOTHING;

  IF FOUND THEN
    RETURN NEW;
  END IF;

  -- If this Auth user already has a profile, do not create another one.
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = NEW.id) THEN
    RETURN NEW;
  END IF;

  -- Resolve username collisions with a generated suffix. ON CONFLICT prevents
  -- a concurrent signup from aborting the Auth transaction.
  LOOP
    v_candidate_username :=
      v_base_username || '_' ||
      SUBSTR(REPLACE(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 12);

    INSERT INTO public.profiles (id, name, username, role)
    VALUES (NEW.id, v_name, v_candidate_username, v_role)
    ON CONFLICT DO NOTHING;

    IF FOUND THEN
      RETURN NEW;
    END IF;

    IF EXISTS (SELECT 1 FROM public.profiles WHERE id = NEW.id) THEN
      RETURN NEW;
    END IF;
  END LOOP;
END;
$function$;
