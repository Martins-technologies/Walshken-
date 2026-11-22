-- Apply only to the explicitly selected Supabase review project.
-- Configure walshken_calling_review_access in Vault separately; never commit its value.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS walshken_private;
REVOKE ALL ON SCHEMA walshken_private FROM PUBLIC;
CREATE OR REPLACE FUNCTION walshken_private.calling_review_tick() RETURNS bigint
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog
AS $function$
DECLARE config jsonb; timestamp_text text; signature text;
BEGIN
  SELECT decrypted_secret::jsonb INTO config FROM vault.decrypted_secrets WHERE name='walshken_calling_review_access';
  IF config IS NULL THEN RETURN NULL; END IF;
  IF (config->>'expiresAt')::numeric <= EXTRACT(EPOCH FROM clock_timestamp())*1000 THEN
    PERFORM cron.unschedule('walshken-calling-review');
    RETURN NULL;
  END IF;
  timestamp_text := floor(EXTRACT(EPOCH FROM clock_timestamp()))::text;
  signature := encode(extensions.hmac('walshken-calling-maintenance:' || timestamp_text,config->>'cronSecret','sha256'),'hex');
  RETURN net.http_get(
    url := 'https://ssggjxyexwkshtcypsaq.supabase.co/functions/v1/walshken-livekit-review',
    headers := jsonb_build_object('Authorization','ReviewCron ' || timestamp_text || '.' || signature),
    timeout_milliseconds := 55000
  );
END;
$function$;
REVOKE ALL ON FUNCTION walshken_private.calling_review_tick() FROM PUBLIC;
SELECT cron.schedule('walshken-calling-review','* * * * *','SELECT walshken_private.calling_review_tick();');
