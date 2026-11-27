CREATE TABLE client_cases (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  reference text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  service text NOT NULL,
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  assigned_employee_id text,
  department_id text,
  division_id text,
  representative_name text NOT NULL DEFAULT '',
  representative_designation text NOT NULL DEFAULT '',
  communication_enabled boolean NOT NULL DEFAULT true,
  internal_status text NOT NULL DEFAULT 'New' CHECK (internal_status IN ('New','Assessing','In progress','Waiting for client','Ready to submit','Submitted to authority','Complete','Closed')),
  client_status text NOT NULL DEFAULT 'Received' CHECK (client_status IN ('Received','Under review','Action required','In progress','Submitted','Decision available','Complete','Closed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at text NOT NULL,
  submitted_at text,
  application_submitted_on date,
  client_updated_at text,
  updated_at text NOT NULL,
  UNIQUE(org_id,id),
  UNIQUE(id,customer_id),
  UNIQUE(org_id,reference),
  FOREIGN KEY(org_id,assigned_employee_id) REFERENCES employees(org_id,id),
  FOREIGN KEY(org_id,department_id) REFERENCES units(org_id,id),
  FOREIGN KEY(org_id,division_id) REFERENCES units(org_id,id),
  CHECK (assigned_employee_id IS NULL OR length(representative_name) BETWEEN 1 AND 100)
);
CREATE INDEX client_cases_customer_lookup ON client_cases(customer_id,updated_at DESC,id);
CREATE INDEX client_cases_assignment_lookup ON client_cases(org_id,assigned_employee_id,updated_at DESC,id);

CREATE TABLE client_case_assignments (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  case_id text NOT NULL,
  employee_id text NOT NULL,
  assigned_by text NOT NULL,
  assigned_at text NOT NULL,
  ended_at text,
  ended_by text,
  FOREIGN KEY(org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY(org_id,employee_id) REFERENCES employees(org_id,id),
  FOREIGN KEY(org_id,assigned_by) REFERENCES employees(org_id,id),
  FOREIGN KEY(org_id,ended_by) REFERENCES employees(org_id,id),
  CHECK ((ended_at IS NULL)=(ended_by IS NULL)),
  CHECK (ended_at IS NULL OR ended_at>=assigned_at)
);
CREATE UNIQUE INDEX client_case_active_assignment ON client_case_assignments(case_id) WHERE ended_at IS NULL;

CREATE FUNCTION preserve_client_case_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL
     OR (NEW.id,NEW.org_id,NEW.case_id,NEW.employee_id,NEW.assigned_by,NEW.assigned_at)
        IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.case_id,OLD.employee_id,OLD.assigned_by,OLD.assigned_at) THEN
    RAISE EXCEPTION 'Client case assignment history is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER client_case_assignment_history BEFORE UPDATE OR DELETE ON client_case_assignments
  FOR EACH ROW EXECUTE FUNCTION preserve_client_case_assignment();

CREATE TABLE client_case_updates (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  case_id text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  proposed_status text CHECK (proposed_status IN ('Received','Under review','Action required','In progress','Submitted','Decision available','Complete','Closed')),
  submission_date date,
  created_by text NOT NULL,
  created_at text NOT NULL,
  decision text NOT NULL DEFAULT 'Pending' CHECK(decision IN ('Pending','Published','Returned')),
  decided_by text,
  decided_at text,
  review_note text,
  FOREIGN KEY(org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES employees(org_id,id),
  FOREIGN KEY(org_id,decided_by) REFERENCES employees(org_id,id),
  CHECK ((decision='Pending' AND decided_at IS NULL AND decided_by IS NULL)
      OR (decision<>'Pending' AND decided_at IS NOT NULL AND decided_by IS NOT NULL AND created_by<>decided_by))
);
CREATE INDEX client_case_updates_lookup ON client_case_updates(case_id,decision,created_at DESC);

CREATE FUNCTION preserve_client_case_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.decision<>'Pending' OR NEW.decision='Pending'
     OR (NEW.id,NEW.org_id,NEW.case_id,NEW.title,NEW.body,NEW.proposed_status,NEW.submission_date,NEW.created_by,NEW.created_at)
         IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.case_id,OLD.title,OLD.body,OLD.proposed_status,OLD.submission_date,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'Client case publish decisions and presented content are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER client_case_update_history BEFORE UPDATE OR DELETE ON client_case_updates
  FOR EACH ROW EXECUTE FUNCTION preserve_client_case_update();

CREATE TABLE client_case_notes (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  case_id text NOT NULL,
  employee_id text NOT NULL,
  body text NOT NULL,
  created_at text NOT NULL,
  FOREIGN KEY(org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY(org_id,employee_id) REFERENCES employees(org_id,id)
);
CREATE INDEX client_case_notes_lookup ON client_case_notes(case_id,created_at DESC);

CREATE TABLE client_case_document_requests (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  case_id text NOT NULL,
  title text NOT NULL,
  instructions text NOT NULL,
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Submitted','Accepted','Replacement requested','Cancelled')),
  created_by text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE(id,org_id,case_id),
  FOREIGN KEY(org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES employees(org_id,id)
);
CREATE INDEX client_case_requests_lookup ON client_case_document_requests(case_id,status,due_on);

CREATE TABLE client_case_messages (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  case_id text NOT NULL,
  direction text NOT NULL CHECK(direction IN ('Client','Company')),
  customer_id text,
  employee_id text,
  display_name text NOT NULL,
  body text NOT NULL,
  created_at text NOT NULL,
  FOREIGN KEY(org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY(case_id,customer_id) REFERENCES client_cases(id,customer_id),
  FOREIGN KEY(org_id,employee_id) REFERENCES employees(org_id,id),
  CHECK ((direction='Client' AND customer_id IS NOT NULL AND employee_id IS NULL)
      OR (direction='Company' AND employee_id IS NOT NULL AND customer_id IS NULL))
);
CREATE INDEX client_case_messages_lookup ON client_case_messages(case_id,created_at DESC);

CREATE TABLE client_case_events (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  case_id text NOT NULL,
  event text NOT NULL,
  employee_id text,
  customer_id text,
  created_at text NOT NULL,
  FOREIGN KEY(org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY(org_id,employee_id) REFERENCES employees(org_id,id),
  FOREIGN KEY(case_id,customer_id) REFERENCES client_cases(id,customer_id),
  CHECK ((employee_id IS NULL)<>(customer_id IS NULL))
);
CREATE INDEX client_case_events_lookup ON client_case_events(case_id,created_at DESC);

CREATE TABLE client_privacy_policies (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  notice text NOT NULL,
  reference text NOT NULL,
  retention_days integer NOT NULL CHECK(retention_days BETWEEN 1 AND 36500),
  published_by text NOT NULL,
  published_at text NOT NULL,
  FOREIGN KEY(org_id,published_by) REFERENCES employees(org_id,id)
);
CREATE INDEX client_privacy_policies_lookup ON client_privacy_policies(org_id,published_at DESC);

CREATE TABLE client_case_legal_holds (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  case_id text,
  reason text NOT NULL,
  created_by text NOT NULL,
  created_at text NOT NULL,
  FOREIGN KEY(org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY(case_id,customer_id) REFERENCES client_cases(id,customer_id),
  FOREIGN KEY(org_id,created_by) REFERENCES employees(org_id,id)
);
CREATE INDEX client_case_legal_holds_lookup ON client_case_legal_holds(org_id,customer_id,case_id);

CREATE TABLE client_case_hold_releases (
  hold_id text PRIMARY KEY REFERENCES client_case_legal_holds(id),
  released_by text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL,
  reason text NOT NULL
);

CREATE TABLE client_consent_records (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  case_id text,
  policy_id text NOT NULL REFERENCES client_privacy_policies(id),
  decision text NOT NULL CHECK(decision IN ('Accepted','Withdrawn')),
  created_at text NOT NULL,
  FOREIGN KEY(org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY(case_id,customer_id) REFERENCES client_cases(id,customer_id)
);
CREATE INDEX client_consent_lookup ON client_consent_records(customer_id,created_at DESC);

CREATE TABLE client_privacy_requests (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  case_id text,
  type text NOT NULL CHECK(type IN ('Data access','Data export','Document deletion','Account closure','Correction')),
  reason text NOT NULL,
  created_at text NOT NULL,
  status text NOT NULL DEFAULT 'Submitted' CHECK(status IN ('Submitted','Under review','Approved','Declined','Completed')),
  public_response text,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  FOREIGN KEY(org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY(case_id,customer_id) REFERENCES client_cases(id,customer_id)
);
CREATE INDEX client_privacy_requests_lookup ON client_privacy_requests(org_id,status,created_at DESC);
CREATE INDEX client_privacy_requests_customer ON client_privacy_requests(customer_id,created_at DESC);
CREATE TABLE client_privacy_decisions (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES client_privacy_requests(id),
  employee_id text NOT NULL REFERENCES employees(id),
  decision text NOT NULL CHECK(decision IN ('Under review','Approved','Declined','Completed')),
  private_reason text NOT NULL,
  public_response text NOT NULL,
  created_at text NOT NULL
);

DO $setup$
DECLARE item text;
BEGIN
  FOREACH item IN ARRAY ARRAY[
    'client_cases','client_case_assignments','client_case_updates','client_case_notes','client_case_document_requests',
    'client_case_messages','client_case_events','client_privacy_policies','client_case_legal_holds','client_case_hold_releases',
    'client_consent_records','client_privacy_requests','client_privacy_decisions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',item);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',item);
    IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon',item);
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated',item);
    END IF;
  END LOOP;
END;
$setup$;
