-- Account content, encryption keys and sync device certificates stay in place.
-- Invalidate every bearer session, refresh and socket ticket, trusted-device
-- token, and pending sign-in/recovery challenge copied from the older server.
BEGIN;
DO $$
DECLARE
  name text;
BEGIN
  IF to_regclass('public.ultra_accounts') IS NULL THEN
    RAISE EXCEPTION 'No restored account schema is present.';
  END IF;
  FOREACH name IN ARRAY ARRAY[
    'ultra_socket_tickets',
    'ultra_refresh_tokens',
    'ultra_sessions',
    'ultra_devices',
    'ultra_challenges'
  ] LOOP
    -- Older supported dumps predate some of these tables.
    IF to_regclass(format('public.%I', name)) IS NOT NULL THEN
      EXECUTE format('DELETE FROM public.%I', name);
    END IF;
  END LOOP;
END
$$;
COMMIT;
