CREATE TABLE staff_meeting_internal_reminders (
  org_id text NOT NULL,
  meeting_id text NOT NULL,
  employee_id text NOT NULL REFERENCES employees(id),
  meeting_revision integer NOT NULL,
  sent_at text NOT NULL,
  PRIMARY KEY(meeting_id, employee_id, meeting_revision),
  FOREIGN KEY(meeting_id,org_id) REFERENCES meetings(id,org_id)
);
ALTER TABLE staff_meeting_internal_reminders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON staff_meeting_internal_reminders FROM PUBLIC;
DO $staff_reminder_privacy$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON staff_meeting_internal_reminders FROM %I',role_name);
    END IF;
  END LOOP;
END
$staff_reminder_privacy$;
