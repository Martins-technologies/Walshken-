ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recording_category text
  CHECK (recording_category IN ('Audio','Video','Group'));
ALTER TABLE meeting_recordings ADD COLUMN IF NOT EXISTS stop_requested_at text,
  ADD COLUMN IF NOT EXISTS policy_revision integer CHECK (policy_revision >= 0),
  ADD COLUMN IF NOT EXISTS participant_consent_required boolean;

CREATE TABLE IF NOT EXISTS meeting_recording_policies (
  org_id text NOT NULL REFERENCES organizations(id),
  enabled boolean NOT NULL,
  request_roles text[] NOT NULL,
  start_roles text[] NOT NULL,
  categories text[] NOT NULL,
  host_approval boolean NOT NULL,
  participant_consent boolean NOT NULL,
  retention_days integer NOT NULL CHECK (retention_days BETWEEN 1 AND 365),
  revision integer NOT NULL CHECK (revision > 0),
  updated_by text NOT NULL REFERENCES employees(id),
  updated_at text NOT NULL,
  PRIMARY KEY(org_id,revision),
  CHECK (request_roles <@ ARRAY['super_admin','admin','hr','manager','employee']::text[]),
  CHECK (start_roles <@ ARRAY['super_admin','admin','hr','manager','employee']::text[]),
  CHECK (categories <@ ARRAY['Audio','Video','Group']::text[]),
  CHECK (NOT enabled OR (cardinality(categories)>0 AND cardinality(start_roles)>0 AND (NOT host_approval OR cardinality(request_roles)>0)))
);

CREATE TABLE IF NOT EXISTS meeting_recording_requests (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  meeting_id text NOT NULL REFERENCES meetings(id),
  policy_revision integer NOT NULL CHECK (policy_revision > 0),
  status text NOT NULL CHECK (status IN ('Pending','Approved','Declined','Used')),
  requested_by text NOT NULL REFERENCES employees(id),
  requested_at text NOT NULL,
  decided_by text REFERENCES employees(id),
  decided_at text,
  CHECK ((status='Pending' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status<>'Pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_recording_request_open
  ON meeting_recording_requests (meeting_id,policy_revision) WHERE status IN ('Pending','Approved');
CREATE INDEX IF NOT EXISTS meeting_recording_request_history
  ON meeting_recording_requests (org_id,meeting_id,requested_at DESC);
ALTER TABLE meeting_recording_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_recording_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON meeting_recording_policies,meeting_recording_requests FROM PUBLIC;
DO $restrict_web_roles$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON meeting_recording_policies,meeting_recording_requests FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON meeting_recording_policies,meeting_recording_requests FROM authenticated;
  END IF;
END;
$restrict_web_roles$;
