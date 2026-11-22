CREATE SCHEMA IF NOT EXISTS walshken_private;
REVOKE ALL ON SCHEMA walshken_private FROM PUBLIC;
CREATE OR REPLACE FUNCTION walshken_private.attendance_review_maintenance() RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $attendance_maintenance$
DECLARE absences integer:=0;alerts integer:=0;at_time text:=to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtext('walshken-preview-attendance-maintenance')) THEN RETURN jsonb_build_object('busy',true);END IF;
 PERFORM id FROM public.organizations WHERE id='walshken' FOR UPDATE;
 WITH facts AS (
 SELECT s.id,s.org_id,s.employee_id,
 CASE WHEN s.state='Cancelled' THEN 'Cancelled'
 WHEN EXISTS(SELECT 1 FROM public.attendance a WHERE a.shift_id=s.id AND a.release_stage='preview') THEN 'Present'
 WHEN EXISTS(SELECT 1 FROM public.leave_requests l WHERE l.employee_id=s.employee_id AND l.release_stage='preview' AND l.status='Approved' AND l.starts_on<=to_char(s.starts_at::timestamptz AT TIME ZONE (CASE WHEN s.time_zone IN('America/Edmonton','Canada/Mountain') AND s.starts_at>='2026-11-01' THEN 'Etc/GMT+6' ELSE s.time_zone END),'YYYY-MM-DD') AND l.ends_on>=to_char(s.starts_at::timestamptz AT TIME ZONE (CASE WHEN s.time_zone IN('America/Edmonton','Canada/Mountain') AND s.starts_at>='2026-11-01' THEN 'Etc/GMT+6' ELSE s.time_zone END),'YYYY-MM-DD') AND l.category='Sick leave') THEN 'Sick leave'
 WHEN EXISTS(SELECT 1 FROM public.leave_requests l WHERE l.employee_id=s.employee_id AND l.release_stage='preview' AND l.status='Approved' AND l.starts_on<=to_char(s.starts_at::timestamptz AT TIME ZONE (CASE WHEN s.time_zone IN('America/Edmonton','Canada/Mountain') AND s.starts_at>='2026-11-01' THEN 'Etc/GMT+6' ELSE s.time_zone END),'YYYY-MM-DD') AND l.ends_on>=to_char(s.starts_at::timestamptz AT TIME ZONE (CASE WHEN s.time_zone IN('America/Edmonton','Canada/Mountain') AND s.starts_at>='2026-11-01' THEN 'Etc/GMT+6' ELSE s.time_zone END),'YYYY-MM-DD')) THEN 'Leave'
 WHEN EXISTS(SELECT 1 FROM public.holidays h JOIN public.employees e ON e.id=s.employee_id WHERE h.org_id=s.org_id AND h.release_stage='preview' AND h.cancelled_at IS NULL AND h.jurisdiction=e.jurisdiction AND h.on_date=to_char(s.starts_at::timestamptz AT TIME ZONE (CASE WHEN s.time_zone IN('America/Edmonton','Canada/Mountain') AND s.starts_at>='2026-11-01' THEN 'Etc/GMT+6' ELSE s.time_zone END),'YYYY-MM-DD')) THEN 'Holiday'
 ELSE 'No show' END AS status
 FROM public.shifts s WHERE s.org_id='walshken' AND s.release_stage='preview' AND s.workflow_version=1 AND s.ends_at::timestamptz<now() AND (s.state='Published' OR EXISTS(SELECT 1 FROM public.attendance_absences x WHERE x.shift_id=s.id))
 ),changed AS (
 INSERT INTO public.attendance_absences(id,org_id,release_stage,shift_id,employee_id,status,recorded_at,updated_at)
 SELECT gen_random_uuid()::text,org_id,'preview',id,employee_id,status,at_time,at_time FROM facts
 ON CONFLICT(shift_id) DO UPDATE SET employee_id=EXCLUDED.employee_id,status=CASE WHEN attendance_absences.manual_excuse=1 AND EXCLUDED.status='No show' THEN 'Excused' ELSE EXCLUDED.status END,updated_at=EXCLUDED.updated_at
 WHERE attendance_absences.status IS DISTINCT FROM CASE WHEN attendance_absences.manual_excuse=1 AND EXCLUDED.status='No show' THEN 'Excused' ELSE EXCLUDED.status END
 RETURNING id
 ) SELECT count(*)::integer INTO absences FROM changed;
 WITH candidates AS (
 SELECT a.id,a.employee_id,e.name,r.id AS recipient,to_char(now() AT TIME ZONE (CASE WHEN a.time_zone IN('America/Edmonton','Canada/Mountain') AND now()>='2026-11-01T00:00:00Z'::timestamptz THEN 'Etc/GMT+6' ELSE a.time_zone END),'YYYY-MM-DD') AS alert_day
 FROM public.attendance a JOIN public.employees e ON e.id=a.employee_id
 JOIN public.employees r ON r.org_id=a.org_id AND r.status='Active' AND r.employment_status<>'Ended'
 WHERE a.org_id='walshken' AND a.release_stage='preview' AND a.workflow_version=1 AND a.ends_at IS NULL AND a.starts_at::timestamptz<now()-interval '16 hours'
 AND (r.id=e.id OR r.role='super_admin' OR (r.role='manager' AND e.manager_id=r.id) OR (r.role IN('admin','hr') AND (r.department_id IS NOT NULL OR r.division_id IS NOT NULL) AND (r.department_id IS NULL OR r.department_id=e.department_id) AND (r.division_id IS NULL OR r.division_id=e.division_id)))
 ),inserted AS (
 INSERT INTO public.work_reminders(id,org_id,release_stage,attendance_id,recipient_id,alert_day,created_at)
 SELECT gen_random_uuid()::text,'walshken','preview',id,recipient,alert_day,at_time FROM candidates
 ON CONFLICT(attendance_id,recipient_id,alert_day) DO NOTHING RETURNING id,attendance_id,recipient_id
 ),notified AS (
 INSERT INTO public.notifications(id,employee_id,title,body,href,release_stage)
 SELECT i.id,i.recipient_id,'Check a missed clock-out',e.name||' has an open work clock older than sixteen hours. Review the actual end time and request a correction.','/staff/attendance','preview' FROM inserted i JOIN public.attendance a ON a.id=i.attendance_id JOIN public.employees e ON e.id=a.employee_id RETURNING id
 ) SELECT count(*)::integer INTO alerts FROM notified;
 RETURN jsonb_build_object('absences',absences,'alerts',alerts,'at',at_time);
END;
$attendance_maintenance$;
REVOKE ALL ON FUNCTION walshken_private.attendance_review_maintenance() FROM PUBLIC;
GRANT USAGE ON SCHEMA walshken_private TO walshken_review_app;
GRANT EXECUTE ON FUNCTION walshken_private.attendance_review_maintenance() TO walshken_review_app;
SELECT cron.schedule('walshken-attendance-preview-maintenance','*/5 * * * *','SELECT walshken_private.attendance_review_maintenance();');
