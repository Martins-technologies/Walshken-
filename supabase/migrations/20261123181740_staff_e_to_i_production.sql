-- Parts E–I production activation. Existing people, credentials and trial workflow records stay in place.
CREATE SCHEMA IF NOT EXISTS walshken_private;
REVOKE ALL ON SCHEMA walshken_private FROM PUBLIC;

-- A timer is exclusive per employee within its own dataset.
ALTER TABLE public.task_time_entries ADD COLUMN release_stage text;
UPDATE public.task_time_entries AS entry SET release_stage=task.release_stage
FROM public.tasks AS task WHERE task.id=entry.task_id;
ALTER TABLE public.task_time_entries ALTER COLUMN release_stage SET NOT NULL;
ALTER TABLE public.task_time_entries ADD CONSTRAINT task_time_stage_valid CHECK (release_stage IN ('preview','production'));
CREATE UNIQUE INDEX task_one_running_timer_per_stage
ON public.task_time_entries(employee_id,release_stage)
WHERE kind='Timer' AND ends_at IS NULL AND voided_at IS NULL;
DROP INDEX public.task_one_running_timer;

CREATE FUNCTION walshken_private.set_task_time_stage() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $stage$
BEGIN
 SELECT t.release_stage INTO STRICT NEW.release_stage FROM public.tasks t
 WHERE t.id=NEW.task_id AND t.org_id=NEW.org_id;
 RETURN NEW;
END;
$stage$;
REVOKE ALL ON FUNCTION walshken_private.set_task_time_stage() FROM PUBLIC;
CREATE TRIGGER task_time_stage BEFORE INSERT OR UPDATE OF task_id,org_id,release_stage ON public.task_time_entries
FOR EACH ROW EXECUTE FUNCTION walshken_private.set_task_time_stage();

-- Copy the shipped legal reference packages. Company adjustments, assignments and payroll remain dataset-specific.
INSERT INTO public.holiday_rules
  (id,org_id,release_stage,jurisdiction,version,effective_from,effective_through,configuration,content_hash,created_at,created_by,reference)
SELECT 'production-'||id,org_id,'production',jurisdiction,version,effective_from,effective_through,configuration,content_hash,created_at,created_by,reference
FROM public.holiday_rules
WHERE org_id='walshken' AND release_stage='preview' AND created_by IS NULL
  AND id='holiday-rule-'||jurisdiction||'-2026-v1'
ON CONFLICT(org_id,release_stage,jurisdiction,version) DO NOTHING;

DO $production_access$
DECLARE t text;
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='walshken_production_app') THEN
  GRANT USAGE ON SCHEMA walshken_private TO walshken_production_app;
  GRANT EXECUTE ON FUNCTION walshken_private.set_task_time_stage() TO walshken_production_app;
  GRANT SELECT,INSERT,UPDATE ON public.tasks TO walshken_production_app;
  CREATE POLICY tasks_production_workflow ON public.tasks TO walshken_production_app
   USING(org_id='walshken' AND release_stage='production')
   WITH CHECK(org_id='walshken' AND release_stage='production' AND workflow_version=1);
  GRANT SELECT,INSERT ON public.task_notes,public.task_reviews,public.task_events,public.task_overdue_alerts TO walshken_production_app;
  GRANT SELECT,INSERT,UPDATE ON public.task_time_entries TO walshken_production_app;
  GRANT SELECT,INSERT,UPDATE(deleted_at) ON public.task_files TO walshken_production_app;
  GRANT SELECT,INSERT,DELETE ON public.task_document_links,public.task_file_cleanup TO walshken_production_app;
  FOREACH t IN ARRAY ARRAY['task_notes','task_time_entries','task_files','task_document_links','task_reviews','task_events','task_overdue_alerts'] LOOP
   EXECUTE format('CREATE POLICY tasks_production_runtime ON public.%I TO walshken_production_app
    USING(org_id=''walshken'' AND EXISTS(SELECT 1 FROM public.tasks t WHERE t.id=task_id AND t.release_stage=''production''))
    WITH CHECK(org_id=''walshken'' AND EXISTS(SELECT 1 FROM public.tasks t WHERE t.id=task_id AND t.release_stage=''production'' AND t.workflow_version=1))',t);
  END LOOP;
  CREATE POLICY tasks_production_cleanup ON public.task_file_cleanup TO walshken_production_app
   USING(org_id='walshken' AND storage_key LIKE 'walshken/walshken/tasks/production/%')
   WITH CHECK(org_id='walshken' AND storage_key LIKE 'walshken/walshken/tasks/production/%');
  GRANT SELECT,INSERT,UPDATE ON public.attendance,public.breaks,public.shifts,public.timesheets,public.corrections,public.leave_requests,public.holidays,public.work_policies,public.shift_swaps,public.attendance_absences TO walshken_production_app;
  GRANT SELECT,INSERT ON public.shift_series,public.work_events,public.work_reminders TO walshken_production_app;
  GRANT SELECT,INSERT,UPDATE ON public.payroll,public.payroll_periods,public.payroll_settings,public.payroll_permissions,public.payroll_openings,public.payroll_earnings,public.payroll_reconciliations TO walshken_production_app;
  GRANT SELECT,INSERT ON public.payroll_members,public.compensation,public.payroll_profiles,public.payroll_payments,public.payroll_events TO walshken_production_app;
  GRANT SELECT,INSERT,UPDATE,DELETE ON public.payroll_sources TO walshken_production_app;
  GRANT UPDATE(voided_at) ON public.compensation TO walshken_production_app;
  GRANT SELECT,INSERT ON public.holiday_rules,public.holiday_assignments,public.holiday_event_versions,public.holiday_allocations,public.holiday_private_records,public.holiday_consents,public.holiday_audit TO walshken_production_app;
  GRANT SELECT,INSERT,UPDATE ON public.holiday_company_events,public.holiday_histories,public.holiday_exceptions,public.holiday_assessments,public.holiday_reconciliations TO walshken_production_app;
  FOREACH t IN ARRAY ARRAY[
   'attendance','shifts','timesheets','leave_requests','holidays','work_policies','shift_series','shift_swaps','attendance_absences','work_events','work_reminders',
   'payroll_members','payroll','payroll_periods','payroll_settings','payroll_permissions','payroll_profiles','payroll_openings','payroll_earnings','payroll_sources','payroll_reconciliations','payroll_payments','payroll_events',
   'holiday_rules','holiday_assignments','holiday_company_events','holiday_event_versions','holiday_histories','holiday_exceptions','holiday_assessments','holiday_allocations','holiday_reconciliations','holiday_private_records','holiday_consents','holiday_audit'
  ] LOOP
   EXECUTE format('CREATE POLICY staff_production_runtime ON public.%I TO walshken_production_app
    USING(org_id=''walshken'' AND release_stage=''production'')
    WITH CHECK(org_id=''walshken'' AND release_stage=''production'')',t);
  END LOOP;
  CREATE POLICY work_production_breaks ON public.breaks TO walshken_production_app
   USING(release_stage='production' AND EXISTS(SELECT 1 FROM public.attendance a WHERE a.id=attendance_id AND a.org_id='walshken' AND a.release_stage='production'))
   WITH CHECK(release_stage='production' AND EXISTS(SELECT 1 FROM public.attendance a WHERE a.id=attendance_id AND a.org_id='walshken' AND a.release_stage='production'));
  CREATE POLICY work_production_corrections ON public.corrections TO walshken_production_app
   USING(release_stage='production' AND EXISTS(SELECT 1 FROM public.employees e WHERE e.id=employee_id AND e.org_id='walshken'))
   WITH CHECK(release_stage='production' AND EXISTS(SELECT 1 FROM public.employees e WHERE e.id=employee_id AND e.org_id='walshken'));
  CREATE POLICY payroll_production_compensation ON public.compensation TO walshken_production_app
   USING(release_stage='production' AND EXISTS(SELECT 1 FROM public.employees e WHERE e.id=employee_id AND e.org_id='walshken'))
   WITH CHECK(release_stage='production' AND EXISTS(SELECT 1 FROM public.employees e WHERE e.id=employee_id AND e.org_id='walshken'));
  CREATE POLICY payroll_production_integration ON public.integrations TO walshken_production_app
   USING(id='payroll-calculator') WITH CHECK(id='payroll-calculator');
  GRANT INSERT(id,employee_id,title,body,href,release_stage) ON public.notifications TO walshken_production_app;
  CREATE POLICY staff_production_notifications ON public.notifications FOR INSERT TO walshken_production_app
   WITH CHECK(release_stage='production'
    AND (href LIKE '/staff/tasks?task=%' OR href IN('/staff/attendance','/staff/approvals','/staff/timesheets','/staff/shifts','/staff/leave','/staff/salary','/staff/payroll','/staff/holiday-calendar'))
    AND EXISTS(SELECT 1 FROM public.employees e WHERE e.id=employee_id AND e.org_id='walshken'));
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='walshken_review_app') THEN
  GRANT USAGE ON SCHEMA walshken_private TO walshken_review_app;
  GRANT EXECUTE ON FUNCTION walshken_private.set_task_time_stage() TO walshken_review_app;
  FOREACH t IN ARRAY ARRAY['tasks','attendance','breaks','shifts','timesheets','corrections','leave_requests','holidays'] LOOP
   EXECUTE format('CREATE POLICY staff_review_workflow_isolation ON public.%I AS RESTRICTIVE TO walshken_review_app
    USING(release_stage=''preview'') WITH CHECK(release_stage=''preview'')',t);
  END LOOP;
  CREATE POLICY task_review_cleanup_isolation ON public.task_file_cleanup AS RESTRICTIVE TO walshken_review_app
   USING(storage_key LIKE 'walshken/walshken/tasks/preview/%') WITH CHECK(storage_key LIKE 'walshken/walshken/tasks/preview/%');
  -- Shared messages, calls and document notifications retain their existing visibility.
  CREATE POLICY staff_review_notification_isolation ON public.notifications AS RESTRICTIVE TO walshken_review_app
   USING(release_stage='preview' OR (href NOT LIKE '/staff/tasks?task=%'
     AND href NOT IN('/staff/attendance','/staff/approvals','/staff/timesheets','/staff/shifts','/staff/leave','/staff/salary','/staff/payroll','/staff/holiday-calendar')))
   WITH CHECK(release_stage='preview' OR (href NOT LIKE '/staff/tasks?task=%'
     AND href NOT IN('/staff/attendance','/staff/approvals','/staff/timesheets','/staff/shifts','/staff/leave','/staff/salary','/staff/payroll','/staff/holiday-calendar')));
 END IF;
END;
$production_access$;

-- The task-file bucket is private and distinct from Preview, documents and recordings.
DO $task_bucket$
BEGIN
 IF to_regclass('storage.buckets') IS NOT NULL THEN
  INSERT INTO storage.buckets(id,name,public,file_size_limit)
  VALUES ('walshken-task-files','walshken-task-files',false,3145728)
  ON CONFLICT (id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id='walshken-task-files' AND NOT public) THEN
   RAISE EXCEPTION 'Production task file bucket must be private';
  END IF;
 END IF;
END;
$task_bucket$;

CREATE OR REPLACE FUNCTION walshken_private.task_review_maintenance() RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public
AS $task_maintenance$
DECLARE entry record; stopped integer:=0; alerts integer:=0; at_time text:=to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtext('walshken-preview-task-maintenance')) THEN RETURN jsonb_build_object('stopped',0,'alerts',0,'busy',true); END IF;
 PERFORM id FROM public.organizations WHERE id='walshken' FOR UPDATE;
 FOR entry IN
  SELECT l.*,t.status AS task_status,e.status AS employee_status,e.employment_status
  FROM public.task_time_entries l JOIN public.tasks t ON t.id=l.task_id JOIN public.employees e ON e.id=l.employee_id
  WHERE t.org_id='walshken' AND t.release_stage='preview' AND t.workflow_version=1
  AND l.kind='Timer' AND l.ends_at IS NULL AND l.voided_at IS NULL
  AND (l.starts_at::timestamptz<=now()-interval '12 hours' OR t.status<>'In Progress' OR e.status<>'Active' OR e.employment_status='Ended' OR t.employee_id<>l.employee_id)
  FOR UPDATE OF l,t SKIP LOCKED
 LOOP
  UPDATE public.task_time_entries SET ends_at=to_char(least(now(),entry.starts_at::timestamptz+interval '12 hours') AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   seconds=greatest(0,least(43200,86400-COALESCE((SELECT SUM(other.seconds) FROM public.task_time_entries other WHERE other.release_stage=entry.release_stage AND other.employee_id=entry.employee_id AND other.worked_on=entry.worked_on AND other.id<>entry.id AND other.voided_at IS NULL),0)::integer,floor(extract(epoch FROM (now()-entry.starts_at::timestamptz)))::integer)),updated_at=at_time WHERE id=entry.id;
  UPDATE public.tasks SET actual_minutes=COALESCE((SELECT SUM(seconds)/60 FROM public.task_time_entries WHERE task_id=entry.task_id AND voided_at IS NULL),0),updated_at=at_time,revision=revision+1 WHERE id=entry.task_id;
  INSERT INTO public.task_events(id,org_id,task_id,actor_id,action,detail,created_at) VALUES(gen_random_uuid()::text,'walshken',entry.task_id,NULL,'Timer automatically stopped','Twelve-hour cap or work/access status changed',at_time);
  stopped:=stopped+1;
 END LOOP;
 WITH candidates AS (
  SELECT t.id AS task_id,t.title,t.due_date,e.name AS employee,recipient.id AS recipient,
   to_char(now() AT TIME ZONE (CASE WHEN t.task_timezone IN('America/Edmonton','Canada/Mountain') AND now()>='2026-11-01T00:00:00Z'::timestamptz THEN 'Etc/GMT+6' ELSE t.task_timezone END),'YYYY-MM-DD') AS alert_day
  FROM public.tasks t JOIN public.employees e ON e.id=t.employee_id AND e.org_id=t.org_id
  JOIN public.employees recipient ON recipient.org_id=t.org_id AND recipient.status='Active' AND recipient.employment_status<>'Ended' AND recipient.role<>'guest'
  WHERE t.org_id='walshken' AND t.release_stage='preview' AND t.workflow_version=1
  AND e.status='Active' AND e.employment_status<>'Ended' AND t.status NOT IN('Completed','Cancelled') AND t.due_date IS NOT NULL
  AND t.due_date<to_char(now() AT TIME ZONE (CASE WHEN t.task_timezone IN('America/Edmonton','Canada/Mountain') AND now()>='2026-11-01T00:00:00Z'::timestamptz THEN 'Etc/GMT+6' ELSE t.task_timezone END),'YYYY-MM-DD')
  AND (recipient.id=e.id OR recipient.role='super_admin' OR (recipient.role='manager' AND e.manager_id=recipient.id)
   OR (recipient.role IN('admin','hr') AND (recipient.department_id IS NOT NULL OR recipient.division_id IS NOT NULL)
    AND (recipient.department_id IS NULL OR recipient.department_id=e.department_id)
    AND (recipient.division_id IS NULL OR recipient.division_id=e.division_id)))
 ), inserted AS (
  INSERT INTO public.task_overdue_alerts(id,org_id,task_id,employee_id,alert_day,due_date,created_at)
  SELECT gen_random_uuid()::text,'walshken',task_id,recipient,alert_day,due_date,at_time FROM candidates
  ON CONFLICT(task_id,employee_id,alert_day,due_date) DO NOTHING RETURNING id,task_id,employee_id
 ), notified AS (
  INSERT INTO public.notifications(id,employee_id,title,body,href,release_stage)
  SELECT i.id,i.employee_id,'Task overdue',left(t.title||' · '||e.name||' · due '||t.due_date,500),'/staff/tasks?task='||t.id,'preview'
  FROM inserted i JOIN public.tasks t ON t.id=i.task_id JOIN public.employees e ON e.id=t.employee_id RETURNING id
 ) SELECT count(*)::integer INTO alerts FROM notified;
 RETURN jsonb_build_object('stopped',stopped,'alerts',alerts,'at',at_time);
END;
$task_maintenance$;
REVOKE ALL ON FUNCTION walshken_private.task_review_maintenance() FROM PUBLIC;

CREATE OR REPLACE FUNCTION walshken_private.task_production_maintenance() RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public
AS $task_maintenance$
DECLARE entry record; stopped integer:=0; alerts integer:=0; at_time text:=to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtext('walshken-production-task-maintenance')) THEN RETURN jsonb_build_object('stopped',0,'alerts',0,'busy',true); END IF;
 PERFORM id FROM public.organizations WHERE id='walshken' FOR UPDATE;
 FOR entry IN
  SELECT l.*,t.status AS task_status,e.status AS employee_status,e.employment_status
  FROM public.task_time_entries l JOIN public.tasks t ON t.id=l.task_id JOIN public.employees e ON e.id=l.employee_id
  WHERE t.org_id='walshken' AND t.release_stage='production' AND t.workflow_version=1
  AND l.kind='Timer' AND l.ends_at IS NULL AND l.voided_at IS NULL
  AND (l.starts_at::timestamptz<=now()-interval '12 hours' OR t.status<>'In Progress' OR e.status<>'Active' OR e.employment_status='Ended' OR t.employee_id<>l.employee_id)
  FOR UPDATE OF l,t SKIP LOCKED
 LOOP
  UPDATE public.task_time_entries SET ends_at=to_char(least(now(),entry.starts_at::timestamptz+interval '12 hours') AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   seconds=greatest(0,least(43200,86400-COALESCE((SELECT SUM(other.seconds) FROM public.task_time_entries other WHERE other.release_stage=entry.release_stage AND other.employee_id=entry.employee_id AND other.worked_on=entry.worked_on AND other.id<>entry.id AND other.voided_at IS NULL),0)::integer,floor(extract(epoch FROM (now()-entry.starts_at::timestamptz)))::integer)),updated_at=at_time WHERE id=entry.id;
  UPDATE public.tasks SET actual_minutes=COALESCE((SELECT SUM(seconds)/60 FROM public.task_time_entries WHERE task_id=entry.task_id AND voided_at IS NULL),0),updated_at=at_time,revision=revision+1 WHERE id=entry.task_id;
  INSERT INTO public.task_events(id,org_id,task_id,actor_id,action,detail,created_at) VALUES(gen_random_uuid()::text,'walshken',entry.task_id,NULL,'Timer automatically stopped','Twelve-hour cap or work/access status changed',at_time);
  stopped:=stopped+1;
 END LOOP;
 WITH candidates AS (
  SELECT t.id AS task_id,t.title,t.due_date,e.name AS employee,recipient.id AS recipient,
   to_char(now() AT TIME ZONE (CASE WHEN t.task_timezone IN('America/Edmonton','Canada/Mountain') AND now()>='2026-11-01T00:00:00Z'::timestamptz THEN 'Etc/GMT+6' ELSE t.task_timezone END),'YYYY-MM-DD') AS alert_day
  FROM public.tasks t JOIN public.employees e ON e.id=t.employee_id AND e.org_id=t.org_id
  JOIN public.employees recipient ON recipient.org_id=t.org_id AND recipient.status='Active' AND recipient.employment_status<>'Ended' AND recipient.role<>'guest'
  WHERE t.org_id='walshken' AND t.release_stage='production' AND t.workflow_version=1
  AND e.status='Active' AND e.employment_status<>'Ended' AND t.status NOT IN('Completed','Cancelled') AND t.due_date IS NOT NULL
  AND t.due_date<to_char(now() AT TIME ZONE (CASE WHEN t.task_timezone IN('America/Edmonton','Canada/Mountain') AND now()>='2026-11-01T00:00:00Z'::timestamptz THEN 'Etc/GMT+6' ELSE t.task_timezone END),'YYYY-MM-DD')
  AND (recipient.id=e.id OR recipient.role='super_admin' OR (recipient.role='manager' AND e.manager_id=recipient.id)
   OR (recipient.role IN('admin','hr') AND (recipient.department_id IS NOT NULL OR recipient.division_id IS NOT NULL)
    AND (recipient.department_id IS NULL OR recipient.department_id=e.department_id)
    AND (recipient.division_id IS NULL OR recipient.division_id=e.division_id)))
 ), inserted AS (
  INSERT INTO public.task_overdue_alerts(id,org_id,task_id,employee_id,alert_day,due_date,created_at)
  SELECT gen_random_uuid()::text,'walshken',task_id,recipient,alert_day,due_date,at_time FROM candidates
  ON CONFLICT(task_id,employee_id,alert_day,due_date) DO NOTHING RETURNING id,task_id,employee_id
 ), notified AS (
  INSERT INTO public.notifications(id,employee_id,title,body,href,release_stage)
  SELECT i.id,i.employee_id,'Task overdue',left(t.title||' · '||e.name||' · due '||t.due_date,500),'/staff/tasks?task='||t.id,'production'
  FROM inserted i JOIN public.tasks t ON t.id=i.task_id JOIN public.employees e ON e.id=t.employee_id RETURNING id
 ) SELECT count(*)::integer INTO alerts FROM notified;
 RETURN jsonb_build_object('stopped',stopped,'alerts',alerts,'at',at_time);
END;
$task_maintenance$;
REVOKE ALL ON FUNCTION walshken_private.task_production_maintenance() FROM PUBLIC;

CREATE OR REPLACE FUNCTION walshken_private.attendance_production_maintenance() RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $attendance_maintenance$
DECLARE absences integer:=0;alerts integer:=0;at_time text:=to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtext('walshken-production-attendance-maintenance')) THEN RETURN jsonb_build_object('busy',true);END IF;
 PERFORM id FROM public.organizations WHERE id='walshken' FOR UPDATE;
 WITH facts AS (
 SELECT s.id,s.org_id,s.employee_id,
 CASE WHEN s.state='Cancelled' THEN 'Cancelled'
 WHEN EXISTS(SELECT 1 FROM public.attendance a WHERE a.shift_id=s.id AND a.release_stage='production') THEN 'Present'
 WHEN EXISTS(SELECT 1 FROM public.leave_requests l WHERE l.employee_id=s.employee_id AND l.release_stage='production' AND l.status='Approved' AND l.starts_on<=to_char(s.starts_at::timestamptz AT TIME ZONE (CASE WHEN s.time_zone IN('America/Edmonton','Canada/Mountain') AND s.starts_at>='2026-11-01' THEN 'Etc/GMT+6' ELSE s.time_zone END),'YYYY-MM-DD') AND l.ends_on>=to_char(s.starts_at::timestamptz AT TIME ZONE (CASE WHEN s.time_zone IN('America/Edmonton','Canada/Mountain') AND s.starts_at>='2026-11-01' THEN 'Etc/GMT+6' ELSE s.time_zone END),'YYYY-MM-DD') AND l.category='Sick leave') THEN 'Sick leave'
 WHEN EXISTS(SELECT 1 FROM public.leave_requests l WHERE l.employee_id=s.employee_id AND l.release_stage='production' AND l.status='Approved' AND l.starts_on<=to_char(s.starts_at::timestamptz AT TIME ZONE (CASE WHEN s.time_zone IN('America/Edmonton','Canada/Mountain') AND s.starts_at>='2026-11-01' THEN 'Etc/GMT+6' ELSE s.time_zone END),'YYYY-MM-DD') AND l.ends_on>=to_char(s.starts_at::timestamptz AT TIME ZONE (CASE WHEN s.time_zone IN('America/Edmonton','Canada/Mountain') AND s.starts_at>='2026-11-01' THEN 'Etc/GMT+6' ELSE s.time_zone END),'YYYY-MM-DD')) THEN 'Leave'
 WHEN EXISTS(SELECT 1 FROM public.holidays h JOIN public.employees e ON e.id=s.employee_id WHERE h.org_id=s.org_id AND h.release_stage='production' AND h.cancelled_at IS NULL AND h.jurisdiction=e.jurisdiction AND h.on_date=to_char(s.starts_at::timestamptz AT TIME ZONE (CASE WHEN s.time_zone IN('America/Edmonton','Canada/Mountain') AND s.starts_at>='2026-11-01' THEN 'Etc/GMT+6' ELSE s.time_zone END),'YYYY-MM-DD')) THEN 'Holiday'
 ELSE 'No show' END AS status
 FROM public.shifts s WHERE s.org_id='walshken' AND s.release_stage='production' AND s.workflow_version=1 AND s.ends_at::timestamptz<now() AND (s.state='Published' OR EXISTS(SELECT 1 FROM public.attendance_absences x WHERE x.shift_id=s.id))
 ),changed AS (
 INSERT INTO public.attendance_absences(id,org_id,release_stage,shift_id,employee_id,status,recorded_at,updated_at)
 SELECT gen_random_uuid()::text,org_id,'production',id,employee_id,status,at_time,at_time FROM facts
 ON CONFLICT(shift_id) DO UPDATE SET employee_id=EXCLUDED.employee_id,status=CASE WHEN attendance_absences.manual_excuse=1 AND EXCLUDED.status='No show' THEN 'Excused' ELSE EXCLUDED.status END,updated_at=EXCLUDED.updated_at
 WHERE attendance_absences.status IS DISTINCT FROM CASE WHEN attendance_absences.manual_excuse=1 AND EXCLUDED.status='No show' THEN 'Excused' ELSE EXCLUDED.status END
 RETURNING id
 ) SELECT count(*)::integer INTO absences FROM changed;
 WITH candidates AS (
 SELECT a.id,a.employee_id,e.name,r.id AS recipient,to_char(now() AT TIME ZONE (CASE WHEN a.time_zone IN('America/Edmonton','Canada/Mountain') AND now()>='2026-11-01T00:00:00Z'::timestamptz THEN 'Etc/GMT+6' ELSE a.time_zone END),'YYYY-MM-DD') AS alert_day
 FROM public.attendance a JOIN public.employees e ON e.id=a.employee_id
 JOIN public.employees r ON r.org_id=a.org_id AND r.status='Active' AND r.employment_status<>'Ended'
 WHERE a.org_id='walshken' AND a.release_stage='production' AND a.workflow_version=1 AND a.ends_at IS NULL AND a.starts_at::timestamptz<now()-interval '16 hours'
 AND (r.id=e.id OR r.role='super_admin' OR (r.role='manager' AND e.manager_id=r.id) OR (r.role IN('admin','hr') AND (r.department_id IS NOT NULL OR r.division_id IS NOT NULL) AND (r.department_id IS NULL OR r.department_id=e.department_id) AND (r.division_id IS NULL OR r.division_id=e.division_id)))
 ),inserted AS (
 INSERT INTO public.work_reminders(id,org_id,release_stage,attendance_id,recipient_id,alert_day,created_at)
 SELECT gen_random_uuid()::text,'walshken','production',id,recipient,alert_day,at_time FROM candidates
 ON CONFLICT(attendance_id,recipient_id,alert_day) DO NOTHING RETURNING id,attendance_id,recipient_id
 ),notified AS (
 INSERT INTO public.notifications(id,employee_id,title,body,href,release_stage)
 SELECT i.id,i.recipient_id,'Check a missed clock-out',e.name||' has an open work clock older than sixteen hours. Review the actual end time and request a correction.','/staff/attendance','production' FROM inserted i JOIN public.attendance a ON a.id=i.attendance_id JOIN public.employees e ON e.id=a.employee_id RETURNING id
 ) SELECT count(*)::integer INTO alerts FROM notified;
 RETURN jsonb_build_object('absences',absences,'alerts',alerts,'at',at_time);
END;
$attendance_maintenance$;
REVOKE ALL ON FUNCTION walshken_private.attendance_production_maintenance() FROM PUBLIC;

DO $schedule$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='walshken_production_app') THEN
  GRANT EXECUTE ON FUNCTION walshken_private.task_production_maintenance() TO walshken_production_app;
 END IF;
 IF to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
  PERFORM cron.schedule('walshken-task-production-maintenance','*/5 * * * *','SELECT walshken_private.task_production_maintenance();');
  PERFORM cron.schedule('walshken-attendance-production-maintenance','*/5 * * * *','SELECT walshken_private.attendance_production_maintenance();');
 END IF;
END;
$schedule$;
