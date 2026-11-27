ALTER TABLE customers
  ADD COLUMN email_verified_at text,
  ADD COLUMN suspended_at text;

ALTER TABLE customer_sessions
  ADD COLUMN session_ref text,
  ADD COLUMN created_at text,
  ADD COLUMN last_seen_at text,
  ADD COLUMN idle_expires_at text,
  ADD COLUMN ended_at text,
  ADD COLUMN reauthenticated_at text,
  ADD COLUMN device_label text,
  ADD COLUMN device_digest text;
CREATE UNIQUE INDEX customer_sessions_public_ref_idx ON customer_sessions(session_ref) WHERE session_ref IS NOT NULL;
CREATE INDEX customer_sessions_activity_idx ON customer_sessions(customer_id, last_seen_at DESC);
CREATE INDEX customer_sessions_device_idx ON customer_sessions(customer_id, device_digest) WHERE device_digest IS NOT NULL;

CREATE TABLE client_auth_challenges (
  id text PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('Registration', 'Verification', 'Password reset', 'Email change')),
  customer_id text REFERENCES customers(id) ON DELETE CASCADE,
  target_email text NOT NULL,
  pending_name text,
  pending_password_hash text,
  account_password_digest text,
  code_digest text NOT NULL,
  created_at text NOT NULL,
  expires_at text NOT NULL,
  workflow_expires_at text NOT NULL,
  resend_after text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
  generation integer NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 4),
  delivery text NOT NULL CHECK (delivery IN ('Pending', 'Accepted', 'Failed', 'Suppressed')),
  provider_receipt text,
  consumed_at text
);
CREATE INDEX client_auth_challenges_address_idx ON client_auth_challenges(target_email, purpose, created_at DESC);
CREATE INDEX client_auth_challenges_expiry_idx ON client_auth_challenges(workflow_expires_at);
CREATE INDEX client_auth_challenges_customer_idx ON client_auth_challenges(customer_id, purpose, created_at DESC);

CREATE TABLE client_profiles (
  customer_id text PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  encrypted_details text NOT NULL,
  verified_fields text[] NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at text NOT NULL
);
CREATE TABLE client_profile_history (
  id text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  actor text NOT NULL CHECK (actor IN ('Client', 'Company')),
  action text NOT NULL CHECK (action IN ('Profile updated', 'Verified fields updated', 'Email changed')),
  fields text[] NOT NULL,
  encrypted_change text,
  created_at text NOT NULL
);
CREATE INDEX client_profile_history_customer_idx ON client_profile_history(customer_id,created_at DESC,id);

CREATE TABLE client_security_events (
  id text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  session_ref text,
  event text NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX client_security_events_customer_idx ON client_security_events(customer_id,created_at DESC,id);

CREATE TABLE client_notification_preferences (
  customer_id text PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  email integer NOT NULL DEFAULT 0 CHECK (email IN (0,1)),
  updated_at text NOT NULL
);
CREATE TABLE client_notifications (
  id text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('security', 'case', 'document', 'payment', 'invoice', 'agreement', 'call', 'announcement')),
  title text NOT NULL,
  body text NOT NULL,
  href text NOT NULL,
  dedupe_key text NOT NULL,
  created_at text NOT NULL,
  read_at text,
  delivery text NOT NULL DEFAULT 'In portal' CHECK (delivery IN ('In portal', 'Queued', 'Processing', 'Accepted', 'Retry', 'Failed', 'Suppressed')),
  available_at text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  lease_until text,
  lease_token text,
  provider_receipt text,
  mail_to text,
  transport_digest text,
  UNIQUE(customer_id,dedupe_key)
);
CREATE INDEX client_notifications_customer_idx ON client_notifications(customer_id,created_at DESC,id);
CREATE INDEX client_notifications_delivery_idx ON client_notifications(delivery,available_at);

ALTER TABLE client_auth_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_profile_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON client_auth_challenges,client_profiles,client_profile_history,client_security_events,
  client_notification_preferences,client_notifications FROM PUBLIC;

DO $client_identity_private$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON client_auth_challenges,client_profiles,client_profile_history,client_security_events,client_notification_preferences,client_notifications FROM %I',role_name);
    END IF;
  END LOOP;
END
$client_identity_private$;
