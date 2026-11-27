-- Run inside the transaction that installs the approved management migrations.
-- Keep QA tables and grants independent, and preserve existing production workflow policies.
SET LOCAL search_path TO public, pg_catalog;

DO $management_checks$
BEGIN
  IF current_schema() <> 'public'
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='walshken_production_app' AND NOT rolsuper AND NOT rolbypassrls)
     OR NOT has_schema_privilege('walshken_production_app','public','USAGE')
     OR has_schema_privilege('walshken_production_app','walshken_role_qa','USAGE')
     OR has_table_privilege('walshken_role_qa_runtime','public.employees','SELECT')
     OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id='walshken') THEN
    RAISE EXCEPTION 'Management release schema or runtime isolation is invalid';
  END IF;
END;
$management_checks$;

DO $management_grants$
DECLARE
  entry record;
  predicate text;
BEGIN
  FOR entry IN SELECT * FROM (VALUES
    ('staff_unit_memberships', 'SELECT, INSERT, DELETE', 'org_id = ''walshken'''),
    ('staff_communication_hidden_employees', 'SELECT, INSERT, DELETE', 'org_id = ''walshken'''),
    ('staff_communication_hidden_units', 'SELECT, INSERT, DELETE', 'org_id = ''walshken'''),
    ('staff_communication_support_departments', 'SELECT, INSERT, DELETE', 'org_id = ''walshken'''),
    ('staff_performance_weights', 'SELECT, INSERT', 'org_id = ''walshken'' AND release_stage = ''production'''),
    ('staff_performance_assessments', 'SELECT, INSERT', 'org_id = ''walshken'' AND release_stage = ''production'''),
    ('staff_performance_assessment_decisions', 'SELECT, INSERT', 'org_id = ''walshken'' AND release_stage = ''production'''),
    ('staff_performance_reports', 'SELECT, INSERT', 'org_id = ''walshken'' AND release_stage = ''production'''),
    ('project_milestones', 'SELECT, INSERT, UPDATE (title, due_on, assignee_id, completed_at, completed_by)',
      'EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_milestones.project_id AND p.org_id = ''walshken'')'),
    ('project_assignments', 'SELECT, INSERT, UPDATE (unassigned_by, unassigned_at)', 'org_id = ''walshken'''),
    ('project_deliverables', 'SELECT, INSERT, UPDATE (title, description, due_on, assignee_id, archived_at)', 'org_id = ''walshken'''),
    ('project_deliverable_versions', 'SELECT, INSERT, UPDATE (status, reviewed_by, reviewed_at, review_note)', 'org_id = ''walshken'''),
    ('project_deadline_notices', 'SELECT, INSERT', 'org_id = ''walshken'''),
    ('staff_meeting_guests', 'SELECT, INSERT, UPDATE', 'org_id = ''walshken'''),
    ('staff_meeting_guest_presence', 'SELECT, INSERT, UPDATE', 'org_id = ''walshken'''),
    ('staff_meeting_guest_emails', 'SELECT, INSERT, UPDATE', 'org_id = ''walshken'''),
    ('staff_meeting_internal_reminders', 'SELECT, INSERT, UPDATE (sent_at)', 'org_id = ''walshken'''),
    ('meeting_recording_policies', 'SELECT, INSERT', 'org_id = ''walshken'''),
    ('meeting_recording_requests', 'SELECT, INSERT, UPDATE (status, decided_by, decided_at)',
      'org_id = ''walshken'' AND EXISTS (SELECT 1 FROM public.meetings m WHERE m.id = meeting_recording_requests.meeting_id AND m.org_id = ''walshken'')')
  ) AS t(table_name, privileges, predicate)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=entry.table_name AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'Required management relation missing or lacks RLS: %', entry.table_name;
    END IF;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,walshken_preview_app,walshken_review_app,walshken_role_qa_runtime', entry.table_name);
    EXECUTE format('GRANT %s ON TABLE public.%I TO walshken_production_app', entry.privileges, entry.table_name);
    EXECUTE format('CREATE POLICY management_production_runtime ON public.%I FOR ALL TO walshken_production_app USING (%s) WITH CHECK (%s)',
      entry.table_name, entry.predicate, entry.predicate);
  END LOOP;
END;
$management_grants$;

GRANT UPDATE (name,description,owner_id,manager_id,department_id,team_id,starts_on,due_on,status,priority,completed_at,submitted_by,submitted_at,archived_from,revision)
  ON public.projects TO walshken_production_app;
CREATE POLICY management_production_project_lifecycle ON public.projects
  FOR UPDATE TO walshken_production_app USING (org_id='walshken') WITH CHECK (
    org_id='walshken'
    AND EXISTS (SELECT 1 FROM public.employees e WHERE e.id=projects.owner_id AND e.org_id=projects.org_id)
    AND (manager_id IS NULL OR EXISTS (SELECT 1 FROM public.employees e WHERE e.id=projects.manager_id AND e.org_id=projects.org_id))
  );

GRANT INSERT (starts_on,due_on,manager_id,team_id,priority) ON public.projects TO walshken_production_app;
GRANT INSERT (recording_category,guest_description,guest_instructions,guest_time_zone,guest_revision),
  UPDATE (recording_category,guest_description,guest_instructions,guest_time_zone,guest_revision,starts_at,ends_at)
  ON public.meetings TO walshken_production_app;
GRANT UPDATE (stop_requested_at,policy_revision,participant_consent_required),
  INSERT (stop_requested_at,policy_revision,participant_consent_required)
  ON public.meeting_recordings TO walshken_production_app;
GRANT UPDATE (external_guest_admission,recording_policy) ON public.organizations TO walshken_production_app;
GRANT INSERT (carry_basis) ON public.staff_leave_adjustments TO walshken_production_app;

-- Lock reminders during manifest verification. A reminder is otherwise append-only.
CREATE POLICY management_reminders_no_update ON public.staff_meeting_internal_reminders AS RESTRICTIVE
  FOR UPDATE TO walshken_production_app USING (true) WITH CHECK (false);

DO $management_disposal$
DECLARE t text; predicate text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_meeting_guests','staff_meeting_guest_presence','staff_meeting_guest_emails',
    'staff_meeting_internal_reminders','meeting_recording_requests'] LOOP
    predicate := format('org_id = ''walshken'' AND public.walshken_source_disposal_allowed(%L,to_jsonb(%I),NULL::jsonb)', t, t);
    EXECUTE format('GRANT DELETE ON public.%I TO walshken_production_app', t);
    -- The normal runtime policy is also applicable to DELETE if SQL privileges permit it.
    -- The restrictive policy additionally requires the exact independently approved source manifest.
    EXECUTE format('CREATE POLICY approved_source_disposal_only ON public.%I AS RESTRICTIVE FOR DELETE TO walshken_production_app USING (%s)', t, predicate);
  END LOOP;
END;
$management_disposal$;
