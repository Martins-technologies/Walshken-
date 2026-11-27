CREATE UNIQUE INDEX staff_employee_org_identity ON employees (org_id,id);
CREATE UNIQUE INDEX staff_unit_org_identity ON units (org_id,id);

CREATE TABLE staff_unit_memberships (
  org_id text NOT NULL REFERENCES organizations(id),
  employee_id text NOT NULL,
  unit_id text NOT NULL,
  created_by text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (org_id,employee_id,unit_id),
  FOREIGN KEY (org_id,employee_id) REFERENCES employees(org_id,id),
  FOREIGN KEY (org_id,unit_id) REFERENCES units(org_id,id),
  FOREIGN KEY (org_id,created_by) REFERENCES employees(org_id,id)
);
CREATE INDEX staff_unit_memberships_unit ON staff_unit_memberships(org_id,unit_id,employee_id);
ALTER TABLE staff_unit_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON staff_unit_memberships FROM PUBLIC;
DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON staff_unit_memberships FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON staff_unit_memberships FROM authenticated;
  END IF;
END;
$roles$;
