-- Directory visibility is independent of employment status, conversation membership and message access.
CREATE TABLE staff_communication_hidden_employees (
  org_id text NOT NULL REFERENCES organizations(id),
  employee_id text NOT NULL,
  created_by text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (org_id, employee_id),
  FOREIGN KEY (org_id, employee_id) REFERENCES employees(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, created_by) REFERENCES employees(org_id, id)
);

CREATE TABLE staff_communication_hidden_units (
  org_id text NOT NULL REFERENCES organizations(id),
  unit_id text NOT NULL,
  created_by text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (org_id, unit_id),
  FOREIGN KEY (org_id, unit_id) REFERENCES units(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, created_by) REFERENCES employees(org_id, id)
);

CREATE TABLE staff_communication_support_departments (
  org_id text NOT NULL REFERENCES organizations(id),
  unit_id text NOT NULL,
  PRIMARY KEY (org_id, unit_id),
  FOREIGN KEY (org_id, unit_id) REFERENCES units(org_id, id) ON DELETE CASCADE
);

-- Preserve the established Support department designation where it already exists.
INSERT INTO staff_communication_support_departments (org_id, unit_id)
SELECT org_id, id FROM units WHERE kind='Department' AND lower(btrim(name))='support';

ALTER TABLE staff_communication_hidden_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_communication_hidden_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_communication_support_departments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON staff_communication_hidden_employees, staff_communication_hidden_units,
  staff_communication_support_departments FROM PUBLIC;

DO $$
DECLARE role_name text;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE ALL ON staff_communication_hidden_employees, staff_communication_hidden_units,
      staff_communication_support_departments FROM %I', role_name);
  END LOOP;
END $$;
