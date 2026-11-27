ALTER TABLE projects
  ADD COLUMN manager_id text,
  ADD COLUMN team_id text,
  ADD COLUMN priority text NOT NULL DEFAULT 'Normal' CHECK (priority IN ('Low','Normal','High','Urgent'));
CREATE UNIQUE INDEX project_org_identity_idx ON projects(org_id,id);
ALTER TABLE projects
  ADD CONSTRAINT project_manager_org_fk FOREIGN KEY (org_id,manager_id) REFERENCES employees(org_id,id),
  ADD CONSTRAINT project_team_org_fk FOREIGN KEY (org_id,team_id) REFERENCES units(org_id,id);
ALTER TABLE project_milestones
  ADD COLUMN assignee_id text REFERENCES employees(id),
  ADD COLUMN completed_by text REFERENCES employees(id);
CREATE INDEX project_milestones_assignee_idx ON project_milestones(assignee_id,due_on) WHERE assignee_id IS NOT NULL;

CREATE TABLE project_assignments (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  employee_id text NOT NULL REFERENCES employees(id),
  assigned_by text NOT NULL REFERENCES employees(id),
  assigned_at text NOT NULL,
  unassigned_by text REFERENCES employees(id),
  unassigned_at text,
  FOREIGN KEY (org_id,project_id) REFERENCES projects(org_id,id),
  FOREIGN KEY (org_id,employee_id) REFERENCES employees(org_id,id),
  FOREIGN KEY (org_id,assigned_by) REFERENCES employees(org_id,id),
  FOREIGN KEY (org_id,unassigned_by) REFERENCES employees(org_id,id),
  CHECK ((unassigned_by IS NULL) = (unassigned_at IS NULL)),
  CHECK (unassigned_at IS NULL OR unassigned_at >= assigned_at)
);
CREATE UNIQUE INDEX project_assignments_active_idx ON project_assignments(project_id,employee_id) WHERE unassigned_at IS NULL;
CREATE INDEX project_assignments_history_idx ON project_assignments(org_id,employee_id,assigned_at);
CREATE FUNCTION preserve_project_assignment_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.unassigned_at IS NOT NULL OR NEW.unassigned_at IS NULL
     OR (NEW.id,NEW.org_id,NEW.project_id,NEW.employee_id,NEW.assigned_by,NEW.assigned_at)
        IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.project_id,OLD.employee_id,OLD.assigned_by,OLD.assigned_at) THEN
    RAISE EXCEPTION 'Project assignment history is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_assignments_history BEFORE UPDATE OR DELETE ON project_assignments
  FOR EACH ROW EXECUTE FUNCTION preserve_project_assignment_history();

CREATE TABLE project_deliverables (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  due_on text NOT NULL,
  assignee_id text REFERENCES employees(id),
  created_by text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL,
  archived_at text,
  UNIQUE(org_id,id),
  FOREIGN KEY (org_id,project_id) REFERENCES projects(org_id,id),
  FOREIGN KEY (org_id,created_by) REFERENCES employees(org_id,id),
  FOREIGN KEY (org_id,assignee_id) REFERENCES employees(org_id,id)
);
CREATE INDEX project_deliverables_project_idx ON project_deliverables(org_id,project_id,due_on);
CREATE TABLE project_deliverable_versions (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  deliverable_id text NOT NULL REFERENCES project_deliverables(id),
  version integer NOT NULL CHECK (version > 0),
  uploaded_by text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL,
  filename text NOT NULL,
  mime text NOT NULL,
  bytes integer NOT NULL CHECK (bytes > 0),
  sha256 text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'Submitted' CHECK(status IN ('Submitted','Approved','Returned')),
  reviewed_by text REFERENCES employees(id),
  reviewed_at text,
  review_note text NOT NULL DEFAULT '',
  UNIQUE(deliverable_id,version),
  FOREIGN KEY (org_id,deliverable_id) REFERENCES project_deliverables(org_id,id),
  FOREIGN KEY (org_id,uploaded_by) REFERENCES employees(org_id,id),
  FOREIGN KEY (org_id,reviewed_by) REFERENCES employees(org_id,id),
  CHECK ((status='Submitted' AND reviewed_by IS NULL AND reviewed_at IS NULL)
       OR (status<>'Submitted' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND uploaded_by<>reviewed_by))
);
CREATE TABLE project_deadline_notices (
  org_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  kind text NOT NULL CHECK (kind IN ('Due soon','Overdue')),
  item_key text NOT NULL,
  due_on text NOT NULL,
  employee_id text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL,
  FOREIGN KEY (org_id,project_id) REFERENCES projects(org_id,id),
  FOREIGN KEY (org_id,employee_id) REFERENCES employees(org_id,id),
  PRIMARY KEY(project_id,kind,item_key,due_on,employee_id)
);

ALTER TABLE project_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_deliverables ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_deliverable_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_deadline_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON project_assignments,project_deliverables,project_deliverable_versions,project_deadline_notices FROM PUBLIC,anon,authenticated;
