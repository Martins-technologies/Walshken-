CREATE TABLE staff_performance_weights (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  release_stage text NOT NULL CHECK (release_stage IN ('preview','production')),
  effective_month text NOT NULL CHECK (effective_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  revision integer NOT NULL CHECK (revision > 0),
  weights jsonb NOT NULL CHECK (jsonb_typeof(weights) = 'object'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  created_by text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL,
  UNIQUE (org_id,release_stage,effective_month,revision)
);

CREATE TABLE staff_performance_assessments (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  release_stage text NOT NULL CHECK (release_stage IN ('preview','production')),
  employee_id text NOT NULL REFERENCES employees(id),
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  review_score integer NOT NULL CHECK (review_score BETWEEN 0 AND 100),
  quality_score integer CHECK (quality_score BETWEEN 0 AND 100),
  evidence text NOT NULL CHECK (length(evidence) BETWEEN 1 AND 1500),
  created_by text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL,
  UNIQUE (org_id,release_stage,id)
);
CREATE INDEX staff_performance_assessments_month_idx
  ON staff_performance_assessments (org_id,release_stage,month,employee_id,created_at);

CREATE TABLE staff_performance_assessment_decisions (
  assessment_id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  release_stage text NOT NULL CHECK (release_stage IN ('preview','production')),
  decision text NOT NULL CHECK (decision IN ('Approved','Rejected')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  decided_by text NOT NULL REFERENCES employees(id),
  decided_at text NOT NULL,
  FOREIGN KEY (org_id,release_stage,assessment_id) REFERENCES staff_performance_assessments(org_id,release_stage,id)
);

CREATE TABLE staff_performance_reports (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  release_stage text NOT NULL CHECK (release_stage IN ('preview','production')),
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  snapshot text NOT NULL CHECK (jsonb_typeof(snapshot::jsonb) = 'object'),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  finalized_by text NOT NULL REFERENCES employees(id),
  finalized_at text NOT NULL,
  UNIQUE (org_id,release_stage,month)
);

CREATE INDEX IF NOT EXISTS shifts_performance_report_idx ON shifts (org_id,release_stage,starts_at,employee_id)
  WHERE state='Published' AND workflow_version=1;
CREATE INDEX IF NOT EXISTS tasks_performance_report_idx ON tasks (org_id,release_stage,due_date,employee_id)
  WHERE workflow_version=1 AND status<>'Cancelled';

CREATE FUNCTION guard_staff_performance_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Performance history is immutable';
END;
$$;
REVOKE ALL ON FUNCTION guard_staff_performance_history() FROM PUBLIC;

DO $performance_guards$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['staff_performance_weights','staff_performance_assessments',
      'staff_performance_assessment_decisions','staff_performance_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',name);
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON %I FROM anon',name);
    END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
      EXECUTE format('REVOKE ALL ON %I FROM authenticated',name);
    END IF;
    EXECUTE format('CREATE TRIGGER performance_history_immutable BEFORE UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION guard_staff_performance_history()',name);
  END LOOP;
END;
$performance_guards$;
