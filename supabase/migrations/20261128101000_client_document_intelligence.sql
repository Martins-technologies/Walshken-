-- Private case-document checks and versioned Preview policy.
ALTER TABLE client_case_document_requests ADD COLUMN expected_category text CHECK (expected_category IN (
  'Grade 10 certificate','Grade 12 certificate','Higher education','Employment evidence','CV or resume',
  'Passport','Identity document','Immigration document','Supporting evidence','Other requested document'
));
ALTER TABLE client_document_versions
  ADD COLUMN quality_flags text[] NOT NULL DEFAULT '{}' CHECK (quality_flags <@ ARRAY[
    'duplicate','low-resolution','low-contrast','blur','blank','unable-to-assess'
  ]::text[]),
  ADD COLUMN submitted_expiry_on date;
ALTER TABLE client_documents
  ADD COLUMN verified_expiry_on date,
  ADD COLUMN verified_expiry_version integer,
  ADD CHECK ((verified_expiry_on IS NULL)=(verified_expiry_version IS NULL)),
  ADD FOREIGN KEY(id,verified_expiry_version) REFERENCES client_document_versions(document_id,version);
CREATE INDEX client_document_checksum ON client_document_versions(org_id,case_id,customer_id,sha256);
CREATE INDEX client_document_expiry ON client_documents(org_id,verified_expiry_on)
  WHERE verified_expiry_on IS NOT NULL AND review_status='Accepted' AND deleted_at IS NULL;

CREATE TABLE client_document_watermark_settings (
  org_id text NOT NULL REFERENCES organizations(id),
  revision integer NOT NULL CHECK(revision>0),
  enabled boolean NOT NULL DEFAULT false,
  label text NOT NULL CHECK(length(label) BETWEEN 1 AND 110),
  opacity integer NOT NULL CHECK(opacity BETWEEN 5 AND 80),
  position text NOT NULL CHECK(position IN ('top','center','bottom')),
  repeat_mark boolean NOT NULL,
  show_client boolean NOT NULL,
  show_time boolean NOT NULL,
  categories text[] NOT NULL CHECK(categories <@ ARRAY[
    'Grade 10 certificate','Grade 12 certificate','Higher education','Employment evidence','CV or resume',
    'Passport','Identity document','Immigration document','Supporting evidence','Other requested document'
  ]::text[] AND (NOT enabled OR cardinality(categories)>0)),
  updated_by text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY(org_id,revision),
  FOREIGN KEY(org_id,updated_by) REFERENCES employees(org_id,id)
);
ALTER TABLE client_document_watermark_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE client_document_watermark_settings FROM PUBLIC;

DO $document_watermark_private$
DECLARE role_name text;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
    EXECUTE format('REVOKE ALL ON TABLE client_document_watermark_settings FROM %I',role_name);
  END LOOP;
END;
$document_watermark_private$;
