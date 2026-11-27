CREATE TABLE client_workflow_stages (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CHECK(length(description)<=500),
  position integer NOT NULL CHECK(position BETWEEN 1 AND 9999),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  UNIQUE(org_id,id)
);
CREATE UNIQUE INDEX client_workflow_stage_names ON client_workflow_stages(org_id,lower(title));
CREATE INDEX client_workflow_stage_order ON client_workflow_stages(org_id,position,id);

INSERT INTO client_workflow_stages(id,org_id,title,position)
SELECT organization.id||':'||stage.code,organization.id,stage.title,stage.position
FROM organizations organization
CROSS JOIN (VALUES
  ('consultation','Consultation',10),('profile','Profile completion',20),
  ('documents','Document collection',30),('review','Document review',40),
  ('preparation','Application preparation',50),('client-approval','Client approval',60),
  ('submission','Application submission',70),('decision-pending','Awaiting decision',80),
  ('decision','Decision received',90)
) AS stage(code,title,position);

CREATE TABLE client_case_milestones (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  case_id text NOT NULL,
  customer_id text NOT NULL,
  workflow_stage_id text NOT NULL,
  stage_title text NOT NULL CHECK(length(stage_title) BETWEEN 1 AND 100),
  stage_position integer NOT NULL,
  state text NOT NULL CHECK(state IN ('Upcoming','In progress','Complete')),
  details text NOT NULL CHECK(length(details) BETWEEN 1 AND 2000),
  next_action text NOT NULL DEFAULT '' CHECK(length(next_action)<=500),
  event_on date,
  submitted_by text NOT NULL,
  submitted_at text NOT NULL,
  decision text NOT NULL DEFAULT 'Pending' CHECK(decision IN ('Pending','Published','Returned')),
  decided_by text,
  decided_at text,
  review_note text NOT NULL DEFAULT '' CHECK(length(review_note)<=500),
  FOREIGN KEY(org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY(case_id,customer_id) REFERENCES client_cases(id,customer_id),
  FOREIGN KEY(org_id,workflow_stage_id) REFERENCES client_workflow_stages(org_id,id),
  FOREIGN KEY(org_id,submitted_by) REFERENCES employees(org_id,id),
  FOREIGN KEY(org_id,decided_by) REFERENCES employees(org_id,id),
  CHECK((decision='Pending' AND decided_by IS NULL AND decided_at IS NULL) OR
    (decision<>'Pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decided_by<>submitted_by)),
  CHECK(state<>'Complete' OR event_on IS NOT NULL)
);
CREATE INDEX client_case_milestone_history ON client_case_milestones(case_id,decision,workflow_stage_id,decided_at DESC,id DESC);
CREATE UNIQUE INDEX client_case_one_pending_milestone ON client_case_milestones(case_id,workflow_stage_id) WHERE decision='Pending';

CREATE FUNCTION protect_client_milestone_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.decision<>'Pending' OR NEW.decision='Pending'
      OR (to_jsonb(OLD)-ARRAY['decision','decided_by','decided_at','review_note'])
         IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['decision','decided_by','decided_at','review_note']) THEN
    RAISE EXCEPTION 'Published client milestone evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER client_case_milestone_history_guard BEFORE UPDATE OR DELETE ON client_case_milestones
  FOR EACH ROW EXECUTE FUNCTION protect_client_milestone_history();

CREATE TABLE client_action_tasks (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  case_id text NOT NULL,
  customer_id text NOT NULL,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 140),
  details text NOT NULL DEFAULT '' CHECK(length(details)<=1500),
  due_on date,
  action_kind text NOT NULL CHECK(action_kind IN ('confirmation','profile','documents','agreements','payments','appointments')),
  status text NOT NULL DEFAULT 'Open' CHECK(status IN('Open','In progress','Completed','Cancelled')),
  assigned_by text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  completed_at text,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  FOREIGN KEY(org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY(case_id,customer_id) REFERENCES client_cases(id,customer_id),
  FOREIGN KEY(org_id,assigned_by) REFERENCES employees(org_id,id),
  CHECK((status='Completed')=(completed_at IS NOT NULL))
);
CREATE INDEX client_action_tasks_owner ON client_action_tasks(customer_id,status,due_on,id);
CREATE INDEX client_action_tasks_case ON client_action_tasks(case_id,updated_at DESC,id);

CREATE TABLE client_dependants (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  case_id text NOT NULL,
  customer_id text NOT NULL,
  encrypted_details text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  archived_at text,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  UNIQUE(id,org_id,case_id,customer_id),
  FOREIGN KEY(org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY(case_id,customer_id) REFERENCES client_cases(id,customer_id)
);
CREATE INDEX client_dependants_case ON client_dependants(case_id,archived_at,created_at,id);

CREATE TABLE client_dependant_documents (
  dependant_id text NOT NULL,
  document_id text NOT NULL,
  org_id text NOT NULL,
  case_id text NOT NULL,
  customer_id text NOT NULL,
  linked_at text NOT NULL,
  unlinked_at text,
  PRIMARY KEY(dependant_id,document_id),
  FOREIGN KEY(dependant_id,org_id,case_id,customer_id) REFERENCES client_dependants(id,org_id,case_id,customer_id),
  FOREIGN KEY(document_id,org_id,case_id,customer_id) REFERENCES client_documents(id,org_id,case_id,customer_id)
);
CREATE INDEX client_dependant_documents_case ON client_dependant_documents(case_id,unlinked_at,dependant_id);

DO $journey_private$
DECLARE item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['client_workflow_stages','client_case_milestones','client_action_tasks','client_dependants','client_dependant_documents'] LOOP
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
$journey_private$;

-- Combine with the workspace runtime role's tenant policy. A client transaction
-- can read only published journey snapshots and can never edit workflow stages.
CREATE POLICY client_workflow_staff_only ON client_workflow_stages AS RESTRICTIVE FOR ALL TO PUBLIC
  USING(NULLIF(current_setting('walshken.client_customer_id',true),'') IS NULL)
  WITH CHECK(NULLIF(current_setting('walshken.client_customer_id',true),'') IS NULL);
CREATE POLICY client_milestone_visibility ON client_case_milestones AS RESTRICTIVE FOR ALL TO PUBLIC
  USING(NULLIF(current_setting('walshken.client_customer_id',true),'') IS NULL
    OR (customer_id=current_setting('walshken.client_customer_id',true) AND decision='Published'))
  WITH CHECK(NULLIF(current_setting('walshken.client_customer_id',true),'') IS NULL);
CREATE POLICY client_action_task_owner ON client_action_tasks AS RESTRICTIVE FOR ALL TO PUBLIC
  USING(NULLIF(current_setting('walshken.client_customer_id',true),'') IS NULL OR customer_id=current_setting('walshken.client_customer_id',true))
  WITH CHECK(NULLIF(current_setting('walshken.client_customer_id',true),'') IS NULL OR customer_id=current_setting('walshken.client_customer_id',true));
CREATE POLICY client_dependant_owner ON client_dependants AS RESTRICTIVE FOR ALL TO PUBLIC
  USING(NULLIF(current_setting('walshken.client_customer_id',true),'') IS NULL OR customer_id=current_setting('walshken.client_customer_id',true))
  WITH CHECK(NULLIF(current_setting('walshken.client_customer_id',true),'') IS NULL OR customer_id=current_setting('walshken.client_customer_id',true));
CREATE POLICY client_dependant_document_owner ON client_dependant_documents AS RESTRICTIVE FOR ALL TO PUBLIC
  USING(NULLIF(current_setting('walshken.client_customer_id',true),'') IS NULL OR customer_id=current_setting('walshken.client_customer_id',true))
  WITH CHECK(NULLIF(current_setting('walshken.client_customer_id',true),'') IS NULL OR customer_id=current_setting('walshken.client_customer_id',true));
