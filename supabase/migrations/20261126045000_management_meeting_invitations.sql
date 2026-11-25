ALTER TABLE meetings ADD COLUMN IF NOT EXISTS guest_description text NOT NULL DEFAULT '';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS guest_instructions text NOT NULL DEFAULT '';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS guest_time_zone text NOT NULL DEFAULT 'UTC';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS guest_revision integer NOT NULL DEFAULT 1 CHECK (guest_revision > 0);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS external_guest_admission text NOT NULL DEFAULT 'Host approval'
  CHECK (external_guest_admission IN ('Host approval', 'Invitation only'));
CREATE UNIQUE INDEX IF NOT EXISTS meetings_org_id_pair ON meetings (id, org_id);

CREATE TABLE staff_meeting_guests (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  meeting_id text NOT NULL,
  email text NOT NULL CHECK (length(email) <= 254 AND email = lower(email)),
  name text NOT NULL DEFAULT '',
  token_nonce text NOT NULL,
  invited_by text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL,
  expires_at text NOT NULL,
  session_hash text,
  rsvp text NOT NULL DEFAULT 'Invited' CHECK (rsvp IN ('Invited', 'Accepted', 'Declined')),
  rsvp_at text,
  requested_at text,
  admitted_at text,
  revoked_at text,
  can_publish integer NOT NULL DEFAULT 1 CHECK(can_publish IN (0,1)),
  can_share integer NOT NULL DEFAULT 0 CHECK(can_share IN (0,1)),
  recording_consent integer CHECK(recording_consent IN (0,1)),
  consent_at text,
  FOREIGN KEY(meeting_id, org_id) REFERENCES meetings(id, org_id),
  UNIQUE(meeting_id,email),
  UNIQUE(id,org_id,meeting_id)
);
CREATE INDEX staff_meeting_guests_meeting ON staff_meeting_guests(org_id,meeting_id);

CREATE TABLE staff_meeting_guest_presence (
  participant_sid text PRIMARY KEY,
  guest_id text NOT NULL,
  org_id text NOT NULL,
  meeting_id text NOT NULL,
  joined_at text,
  left_at text,
  reason text,
  FOREIGN KEY(guest_id,org_id,meeting_id) REFERENCES staff_meeting_guests(id,org_id,meeting_id)
);
CREATE INDEX staff_meeting_guest_presence_guest ON staff_meeting_guest_presence(guest_id,meeting_id);

CREATE TABLE staff_meeting_guest_emails (
  id text PRIMARY KEY,
  guest_id text NOT NULL,
  org_id text NOT NULL,
  meeting_id text NOT NULL,
  event_key text NOT NULL,
  event_type text NOT NULL CHECK(event_type IN ('Invitation','Reminder','Rescheduled','Cancelled')),
  meeting_revision integer NOT NULL,
  status text NOT NULL CHECK(status IN ('Queued','Processing','Retry','Sent','Failed','Superseded')),
  available_at text NOT NULL,
  created_at text NOT NULL,
  first_attempt_at text,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  lease_token text,
  lease_until text,
  transport_key_hash text,
  payload_hash text,
  provider_id text,
  error_code text,
  sent_at text,
  FOREIGN KEY(guest_id,org_id,meeting_id) REFERENCES staff_meeting_guests(id,org_id,meeting_id),
  UNIQUE(guest_id,event_key)
);
CREATE INDEX staff_meeting_guest_email_due ON staff_meeting_guest_emails(status,available_at);
CREATE INDEX staff_meeting_guest_email_history ON staff_meeting_guest_emails(guest_id,created_at DESC);

ALTER TABLE staff_meeting_guests ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_meeting_guest_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_meeting_guest_emails ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON staff_meeting_guests, staff_meeting_guest_presence, staff_meeting_guest_emails FROM PUBLIC;
DO $guest_privacy$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON staff_meeting_guests, staff_meeting_guest_presence, staff_meeting_guest_emails FROM %I',role_name);
    END IF;
  END LOOP;
END
$guest_privacy$;
