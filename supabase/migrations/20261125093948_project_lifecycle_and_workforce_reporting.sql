ALTER TABLE projects
  ADD COLUMN starts_on text,
  ADD COLUMN due_on text,
  ADD COLUMN submitted_by text REFERENCES employees(id),
  ADD COLUMN submitted_at text,
  ADD COLUMN completed_at text,
  ADD COLUMN archived_from text,
  ADD COLUMN revision integer NOT NULL DEFAULT 1;

CREATE TABLE project_milestones (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  title text NOT NULL,
  due_on text NOT NULL,
  completed_at text,
  created_by text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL
);
CREATE INDEX project_milestones_project_idx ON project_milestones(project_id,due_on);
ALTER TABLE project_milestones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON project_milestones FROM PUBLIC,anon,authenticated;

CREATE INDEX shifts_expected_timesheet_idx ON shifts(org_id, release_stage, ends_at)
  WHERE workflow_version = 1 AND state = 'Published';
CREATE INDEX attendance_expected_timesheet_idx ON attendance(shift_id, employee_id, release_stage)
  WHERE workflow_version = 1;
