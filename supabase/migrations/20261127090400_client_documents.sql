CREATE TABLE IF NOT EXISTS client_documents (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  case_id text NOT NULL,
  customer_id text NOT NULL REFERENCES customers(id),
  request_id text,
  category text NOT NULL CHECK (category IN ('Grade 10 certificate','Grade 12 certificate','Higher education','Employment evidence','CV or resume','Passport','Identity document','Immigration document','Supporting evidence','Other requested document')),
  description text NOT NULL CHECK (length(description)<=1000),
  review_status text NOT NULL DEFAULT 'Submitted' CHECK (review_status IN ('Submitted','Accepted','Replacement requested')),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  deleted_at text,
  UNIQUE(id,org_id,case_id,customer_id),
  FOREIGN KEY (org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY (case_id,customer_id) REFERENCES client_cases(id,customer_id),
  FOREIGN KEY (request_id,org_id,case_id) REFERENCES client_case_document_requests(id,org_id,case_id)
);

CREATE TABLE IF NOT EXISTS client_document_versions (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  case_id text NOT NULL,
  customer_id text NOT NULL,
  document_id text NOT NULL,
  upload_nonce text NOT NULL,
  version integer NOT NULL CHECK (version>0),
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 150),
  mime text NOT NULL CHECK (mime IN ('application/pdf','image/jpeg','image/png')),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 3145728),
  sha256 text NOT NULL CHECK (length(sha256)=64),
  storage_key text NOT NULL UNIQUE,
  storage_backend text NOT NULL CHECK (storage_backend IN ('s3','preview-db')),
  page_count integer NOT NULL CHECK (page_count BETWEEN 1 AND 200),
  scan_status text NOT NULL CHECK (scan_status IN ('Clean','Scanning deferred')),
  submitted_at text NOT NULL,
  retain_until text NOT NULL,
  UNIQUE(document_id,version),
  UNIQUE(case_id,customer_id,upload_nonce),
  FOREIGN KEY (document_id,org_id,case_id,customer_id) REFERENCES client_documents(id,org_id,case_id,customer_id)
);

CREATE TABLE IF NOT EXISTS client_document_events (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  case_id text NOT NULL,
  customer_id text NOT NULL,
  document_id text NOT NULL,
  version_id text REFERENCES client_document_versions(id),
  staff_id text REFERENCES employees(id),
  action text NOT NULL CHECK (action IN ('Uploaded','Replaced','Reviewed','Previewed','Downloaded original','Hold placed','Hold released','Deletion requested','Deletion declined','Deletion approved','Originals disposed','Original access changed')),
  detail text NOT NULL DEFAULT '',
  occurred_at text NOT NULL,
  FOREIGN KEY (document_id,org_id,case_id,customer_id) REFERENCES client_documents(id,org_id,case_id,customer_id)
);

CREATE TABLE IF NOT EXISTS client_document_holds (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  case_id text NOT NULL,
  customer_id text NOT NULL,
  document_id text NOT NULL,
  placed_by text NOT NULL REFERENCES employees(id),
  reason text NOT NULL,
  placed_at text NOT NULL,
  released_by text REFERENCES employees(id),
  release_reason text,
  released_at text,
  CHECK ((released_at IS NULL AND released_by IS NULL AND release_reason IS NULL) OR (released_at IS NOT NULL AND released_by IS NOT NULL AND release_reason IS NOT NULL AND released_by<>placed_by)),
  FOREIGN KEY (document_id,org_id,case_id,customer_id) REFERENCES client_documents(id,org_id,case_id,customer_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS client_document_one_hold ON client_document_holds(document_id) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS client_document_disposals (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  case_id text NOT NULL,
  customer_id text NOT NULL,
  document_id text NOT NULL,
  requested_by_staff text REFERENCES employees(id),
  requested_at text NOT NULL,
  request_reason text NOT NULL,
  status text NOT NULL DEFAULT 'Requested' CHECK (status IN ('Requested','Declined','Approved','Disposed')),
  reviewed_by text REFERENCES employees(id),
  reviewed_at text,
  review_reason text,
  disposed_at text,
  CHECK ((status='Requested' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR (status<>'Requested' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_reason IS NOT NULL)),
  CHECK ((status='Disposed')=(disposed_at IS NOT NULL)),
  FOREIGN KEY (document_id,org_id,case_id,customer_id) REFERENCES client_documents(id,org_id,case_id,customer_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS client_document_one_pending_disposal ON client_document_disposals(document_id) WHERE status IN ('Requested','Approved');

CREATE TABLE IF NOT EXISTS client_document_policies (
  org_id text NOT NULL REFERENCES organizations(id),
  revision integer NOT NULL CHECK (revision>0),
  retain_days integer NOT NULL CHECK (retain_days BETWEEN 1 AND 36500),
  client_download boolean NOT NULL DEFAULT false,
  policy_basis text NOT NULL CHECK (length(policy_basis)>0),
  reviewed_by text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL,
  PRIMARY KEY (org_id,revision)
);

CREATE TABLE IF NOT EXISTS client_preview_document_objects (
  storage_key text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  mime text NOT NULL,
  body bytea NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 3145728),
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS client_upload_pending_objects (
  storage_key text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  storage_backend text NOT NULL CHECK (storage_backend IN ('s3','preview-db')),
  created_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS client_doc_cases ON client_documents(org_id,case_id,created_at DESC);
CREATE INDEX IF NOT EXISTS client_document_audit_search ON client_document_events(org_id,document_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS client_pending_uploads_cleanup ON client_upload_pending_objects(org_id,created_at);

ALTER TABLE client_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_document_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_document_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_document_disposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_document_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_preview_document_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_upload_pending_objects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE client_documents,client_document_versions,client_document_events,client_document_holds,client_document_disposals,client_document_policies,client_preview_document_objects,client_upload_pending_objects FROM PUBLIC;
DO $no_web_roles$
DECLARE role_name text;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
    EXECUTE format('REVOKE ALL ON TABLE client_documents,client_document_versions,client_document_events,client_document_holds,client_document_disposals,client_document_policies,client_preview_document_objects,client_upload_pending_objects FROM %I',role_name);
  END LOOP;
END;
$no_web_roles$;
