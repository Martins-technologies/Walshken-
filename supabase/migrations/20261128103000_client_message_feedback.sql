-- Extend existing case conversations. A null endpoint is the original representative
-- thread; office destinations share the same routing registry as client calls.
ALTER TABLE client_document_versions ADD CONSTRAINT client_document_version_case_key UNIQUE (id,org_id,case_id);
ALTER TABLE client_case_messages
  ADD COLUMN endpoint_id text,
  ADD COLUMN attachment_version_id text,
  ADD CONSTRAINT client_case_message_org_case_key UNIQUE (id,org_id,case_id),
  ADD CONSTRAINT client_case_message_endpoint_fk FOREIGN KEY (org_id,endpoint_id) REFERENCES client_call_endpoints(org_id,id),
  ADD CONSTRAINT client_case_message_file_fk FOREIGN KEY (attachment_version_id,org_id,case_id) REFERENCES client_document_versions(id,org_id,case_id),
  ADD CONSTRAINT client_case_message_file_scope CHECK (attachment_version_id IS NULL OR endpoint_id IS NULL);
CREATE INDEX client_case_message_threads ON client_case_messages(org_id,case_id,endpoint_id,created_at DESC,id DESC);
CREATE INDEX client_office_message_queue ON client_case_messages(org_id,endpoint_id,case_id,created_at DESC) WHERE endpoint_id IS NOT NULL;

CREATE TABLE client_case_message_receipts (
  org_id text NOT NULL,
  case_id text NOT NULL,
  customer_id text NOT NULL,
  message_id text NOT NULL,
  reader_side text NOT NULL CHECK (reader_side IN ('Client','Company')),
  reader_id text NOT NULL,
  employee_id text,
  read_at text NOT NULL,
  PRIMARY KEY(message_id,reader_side,reader_id),
  FOREIGN KEY(message_id,org_id,case_id) REFERENCES client_case_messages(id,org_id,case_id),
  FOREIGN KEY(case_id,customer_id) REFERENCES client_cases(id,customer_id),
  FOREIGN KEY(org_id,employee_id) REFERENCES employees(org_id,id),
  CHECK ((reader_side='Client' AND reader_id=customer_id AND employee_id IS NULL)
    OR (reader_side='Company' AND employee_id IS NOT NULL AND reader_id=employee_id))
);
CREATE INDEX client_case_message_receipt_reader ON client_case_message_receipts(case_id,reader_side,reader_id);

CREATE TABLE client_feedback_submissions (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  case_id text,
  appointment_id text,
  kind text NOT NULL CHECK(kind IN ('Support request','Complaint','Consultation feedback','Service rating','Case closure feedback')),
  title text NOT NULL CHECK(length(title) BETWEEN 3 AND 140),
  body text NOT NULL CHECK(length(body) BETWEEN 3 AND 4000),
  rating integer CHECK(rating BETWEEN 1 AND 5),
  status text NOT NULL DEFAULT 'New' CHECK(status IN ('New','In review','Responded','Closed')),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  UNIQUE(id,org_id,customer_id),
  FOREIGN KEY(org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY(case_id,customer_id) REFERENCES client_cases(id,customer_id),
  FOREIGN KEY(org_id,appointment_id,customer_id) REFERENCES client_appointments(org_id,id,customer_id),
  CHECK ((kind='Consultation feedback')=(appointment_id IS NOT NULL)),
  CHECK ((kind IN ('Support request','Complaint'))=(rating IS NULL)),
  CHECK (kind NOT IN ('Consultation feedback','Case closure feedback') OR case_id IS NOT NULL)
);
CREATE INDEX client_feedback_person_history ON client_feedback_submissions(customer_id,created_at DESC,id);
CREATE INDEX client_feedback_queue ON client_feedback_submissions(org_id,status,updated_at DESC,id);
CREATE INDEX client_feedback_report ON client_feedback_submissions(org_id,created_at,kind,status);
CREATE UNIQUE INDEX client_feedback_consultation_once ON client_feedback_submissions(appointment_id) WHERE appointment_id IS NOT NULL;
CREATE UNIQUE INDEX client_feedback_case_closure_once ON client_feedback_submissions(case_id) WHERE kind='Case closure feedback';

CREATE TABLE client_feedback_responses (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  customer_id text NOT NULL,
  submission_id text NOT NULL,
  employee_id text NOT NULL,
  body text NOT NULL CHECK(length(body) BETWEEN 3 AND 4000),
  status text NOT NULL CHECK(status IN ('In review','Responded','Closed')),
  created_at text NOT NULL,
  FOREIGN KEY(submission_id,org_id,customer_id) REFERENCES client_feedback_submissions(id,org_id,customer_id),
  FOREIGN KEY(org_id,employee_id) REFERENCES employees(org_id,id)
);
CREATE INDEX client_feedback_response_history ON client_feedback_responses(submission_id,created_at,id);

ALTER TABLE client_case_message_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_feedback_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_feedback_responses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON client_case_message_receipts,client_feedback_submissions,client_feedback_responses FROM PUBLIC;

CREATE POLICY client_case_message_receipt_owner ON client_case_message_receipts AS RESTRICTIVE
  USING (NULLIF(current_setting('walshken.client_customer_id',true),'') IS NULL OR customer_id=NULLIF(current_setting('walshken.client_customer_id',true),''));
CREATE POLICY client_feedback_submission_owner ON client_feedback_submissions AS RESTRICTIVE
  USING (NULLIF(current_setting('walshken.client_customer_id',true),'') IS NULL OR customer_id=NULLIF(current_setting('walshken.client_customer_id',true),''));
CREATE POLICY client_feedback_response_owner ON client_feedback_responses AS RESTRICTIVE
  USING (NULLIF(current_setting('walshken.client_customer_id',true),'') IS NULL OR customer_id=NULLIF(current_setting('walshken.client_customer_id',true),''));

DO $client_support_private$
DECLARE browser_role text;
BEGIN
  FOREACH browser_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=browser_role) THEN
      EXECUTE format('REVOKE ALL ON client_case_message_receipts,client_feedback_submissions,client_feedback_responses FROM %I',browser_role);
    END IF;
  END LOOP;
END
$client_support_private$;

CREATE FUNCTION client_support_history_read_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Client communication history is immutable';
END;
$$;
CREATE TRIGGER client_case_receipt_read_only
  BEFORE UPDATE OR DELETE ON client_case_message_receipts
  FOR EACH ROW EXECUTE FUNCTION client_support_history_read_only();
CREATE TRIGGER client_feedback_response_read_only
  BEFORE UPDATE OR DELETE ON client_feedback_responses
  FOR EACH ROW EXECUTE FUNCTION client_support_history_read_only();

CREATE FUNCTION client_feedback_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Client feedback cannot be removed'; END IF;
  IF (to_jsonb(NEW)-ARRAY['status','updated_at','revision'])<>(to_jsonb(OLD)-ARRAY['status','updated_at','revision'])
    OR NEW.revision<>OLD.revision+1
    OR OLD.status='Closed' AND NEW.status<>'In review'
    OR NEW.status='New' THEN
    RAISE EXCEPTION 'Invalid client feedback revision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER client_feedback_revision_guard
  BEFORE UPDATE OR DELETE ON client_feedback_submissions
  FOR EACH ROW EXECUTE FUNCTION client_feedback_revision_guard();
