-- Run in the same transaction as the management migrations after setting
-- search_path to walshken_role_qa, pg_catalog. This is a Preview-only grant file.
DO $management_preview$
DECLARE
  entry record;
  predicate text;
BEGIN
  IF current_schema() <> 'walshken_role_qa' THEN
    RAISE EXCEPTION 'The management grant script is scoped to walshken_role_qa';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='walshken_role_qa_runtime' AND NOT rolsuper AND NOT rolbypassrls)
     OR NOT has_schema_privilege('walshken_role_qa_runtime','walshken_role_qa','USAGE')
     OR has_schema_privilege('walshken_production_app','walshken_role_qa','USAGE')
     OR has_table_privilege('walshken_role_qa_runtime','public.employees','SELECT') THEN
    RAISE EXCEPTION 'The QA runtime role is missing or database isolation has changed';
  END IF;

  FOR entry IN SELECT * FROM (VALUES
    ('staff_unit_memberships', 'SELECT, INSERT, DELETE', false),
    ('staff_communication_hidden_employees', 'SELECT, INSERT, DELETE', false),
    ('staff_communication_hidden_units', 'SELECT, INSERT, DELETE', false),
    ('staff_communication_support_departments', 'SELECT, INSERT, DELETE', false),
    ('staff_performance_weights', 'SELECT, INSERT', true),
    ('staff_performance_assessments', 'SELECT, INSERT', true),
    ('staff_performance_assessment_decisions', 'SELECT, INSERT', true),
    ('staff_performance_reports', 'SELECT, INSERT', true),
    ('project_assignments', 'SELECT, INSERT, UPDATE (unassigned_by, unassigned_at)', false),
    ('project_deliverables', 'SELECT, INSERT, UPDATE', false),
    ('project_deliverable_versions', 'SELECT, INSERT, UPDATE (status, reviewed_by, reviewed_at, review_note)', false),
    ('project_deadline_notices', 'SELECT, INSERT', false),
    ('staff_meeting_guests', 'SELECT, INSERT, UPDATE', false),
    ('staff_meeting_guest_presence', 'SELECT, INSERT, UPDATE', false),
    ('staff_meeting_guest_emails', 'SELECT, INSERT, UPDATE', false),
    ('staff_meeting_internal_reminders', 'SELECT, INSERT', false),
    ('meeting_recording_policies', 'SELECT, INSERT', false),
    ('meeting_recording_requests', 'SELECT, INSERT, UPDATE', false)
  ) AS t(table_name, privileges, stage_scoped)
  LOOP
    predicate := 'org_id = ''walshken''';
    IF entry.stage_scoped THEN
      predicate := predicate || ' AND release_stage = ''preview''';
    END IF;
    EXECUTE format('REVOKE ALL ON TABLE walshken_role_qa.%I FROM PUBLIC, anon, authenticated', entry.table_name);
    EXECUTE format('GRANT %s ON TABLE walshken_role_qa.%I TO walshken_role_qa_runtime', entry.privileges, entry.table_name);
    EXECUTE format('CREATE POLICY management_preview_runtime ON walshken_role_qa.%I FOR ALL TO walshken_role_qa_runtime USING (%s) WITH CHECK (%s)',
      entry.table_name, predicate, predicate);
  END LOOP;
END;
$management_preview$;

GRANT INSERT (team_id,manager_id,priority), UPDATE (team_id,manager_id,priority)
  ON walshken_role_qa.projects TO walshken_role_qa_runtime;
GRANT INSERT (assignee_id,completed_by), UPDATE (assignee_id,completed_by)
  ON walshken_role_qa.project_milestones TO walshken_role_qa_runtime;
GRANT INSERT (recording_category,guest_description,guest_instructions,guest_time_zone,guest_revision),
  UPDATE (recording_category,guest_description,guest_instructions,guest_time_zone,guest_revision,starts_at,ends_at)
  ON walshken_role_qa.meetings TO walshken_role_qa_runtime;
GRANT UPDATE (stop_requested_at,policy_revision,participant_consent_required),
  INSERT (stop_requested_at,policy_revision,participant_consent_required)
  ON walshken_role_qa.meeting_recordings TO walshken_role_qa_runtime;
GRANT UPDATE (external_guest_admission,recording_policy)
  ON walshken_role_qa.organizations TO walshken_role_qa_runtime;
