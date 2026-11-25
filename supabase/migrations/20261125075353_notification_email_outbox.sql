-- No existing notification is backfilled. Email is off until each recipient opts in.
CREATE TABLE notification_email_preferences (
 employee_id text PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
 org_id text NOT NULL REFERENCES organizations(id),
 enabled integer NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at text NOT NULL
);
CREATE TABLE notification_email_outbox (
 id text PRIMARY KEY,
 notification_id text NOT NULL UNIQUE REFERENCES notifications(id) ON DELETE CASCADE,
 employee_id text NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
 org_id text NOT NULL REFERENCES organizations(id),
 status text NOT NULL DEFAULT 'Pending' CHECK(status IN('Pending','Processing','Retry','Sent','Skipped','Failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0 AND attempts<=6),
 available_at text NOT NULL,
 lease_token text,
 lease_until text,
 first_attempt_at text,
 encrypted_payload text,
 transport_key_hash text,
 provider_id text,
 error_code text,
 created_at text NOT NULL,
 updated_at text NOT NULL,
 sent_at text
);
CREATE INDEX notification_email_due ON notification_email_outbox(org_id,available_at,created_at) WHERE status IN('Pending','Retry');
CREATE INDEX notification_email_lease ON notification_email_outbox(org_id,lease_until) WHERE status='Processing';
CREATE INDEX notification_email_recipient ON notification_email_outbox(employee_id,created_at DESC);
ALTER TABLE notification_email_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_email_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON notification_email_preferences,notification_email_outbox FROM PUBLIC;
DO $grants$
DECLARE role_name text;
BEGIN
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated') LOOP
  EXECUTE format('REVOKE ALL ON notification_email_preferences,notification_email_outbox FROM %I',role_name);
 END LOOP;
END;
$grants$;

CREATE FUNCTION walshken_enqueue_notification_email() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $enqueue$
BEGIN
 IF TG_TABLE_SCHEMA='public' AND (
  to_jsonb(NEW)->>'release_stage' IS DISTINCT FROM 'production'
  OR current_user NOT IN('walshken_production_app','postgres')
 ) THEN RETURN NEW; END IF;
 -- TG_TABLE_SCHEMA keeps preview and production queues in their own schema.
 -- This invoker function retains the caller's RLS and table privileges.
 EXECUTE format(
  'INSERT INTO %1$I.notification_email_outbox(id,notification_id,employee_id,org_id,available_at,created_at,updated_at)
   SELECT $1,$1,e.id,e.org_id,$3,$3,$3 FROM %1$I.employees e
   JOIN %1$I.notification_email_preferences p ON p.employee_id=e.id AND p.org_id=e.org_id
   WHERE e.id=$2 AND e.status=''Active'' AND e.employment_status<>''Ended'' AND p.enabled=1
   ON CONFLICT(notification_id) DO NOTHING',TG_TABLE_SCHEMA)
 USING NEW.id,NEW.employee_id,NEW.created_at;
 RETURN NEW;
END;
$enqueue$;
REVOKE ALL ON FUNCTION walshken_enqueue_notification_email() FROM PUBLIC;
CREATE TRIGGER notification_email_enqueue AFTER INSERT ON notifications
FOR EACH ROW WHEN(NEW.read_at IS NULL) EXECUTE FUNCTION walshken_enqueue_notification_email();
