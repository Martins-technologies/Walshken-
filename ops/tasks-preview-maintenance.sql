-- SQL-only Preview maintenance. No provider keys or Vercel authentication are needed.
CREATE SCHEMA IF NOT EXISTS walshken_private;
REVOKE ALL ON SCHEMA walshken_private FROM PUBLIC;
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
   seconds=greatest(0,least(43200,86400-COALESCE((SELECT SUM(other.seconds) FROM public.task_time_entries other WHERE other.employee_id=entry.employee_id AND other.worked_on=entry.worked_on AND other.id<>entry.id AND other.voided_at IS NULL),0)::integer,floor(extract(epoch FROM (now()-entry.starts_at::timestamptz)))::integer)),updated_at=at_time WHERE id=entry.id;
  UPDATE public.tasks SET actual_minutes=COALESCE((SELECT SUM(seconds)/60 FROM public.task_time_entries WHERE task_id=entry.task_id AND voided_at IS NULL),0),updated_at=at_time,revision=revision+1 WHERE id=entry.task_id;
  INSERT INTO public.task_events(id,org_id,task_id,actor_id,action,detail,created_at) VALUES(gen_random_uuid()::text,'walshken',entry.task_id,NULL,'Timer automatically stopped','Twelve-hour cap or work/access status changed',at_time);
  stopped:=stopped+1;
 END LOOP;
 WITH candidates AS (
  SELECT t.id AS task_id,t.title,t.due_date,e.name AS employee,recipient.id AS recipient,
   to_char(now() AT TIME ZONE t.task_timezone,'YYYY-MM-DD') AS alert_day
  FROM public.tasks t JOIN public.employees e ON e.id=t.employee_id AND e.org_id=t.org_id
  JOIN public.employees recipient ON recipient.org_id=t.org_id AND recipient.status='Active' AND recipient.employment_status<>'Ended' AND recipient.role<>'guest'
  WHERE t.org_id='walshken' AND t.release_stage='preview' AND t.workflow_version=1
  AND e.status='Active' AND e.employment_status<>'Ended' AND t.status NOT IN('Completed','Cancelled') AND t.due_date IS NOT NULL
  AND t.due_date<to_char(now() AT TIME ZONE t.task_timezone,'YYYY-MM-DD')
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
GRANT USAGE ON SCHEMA walshken_private TO walshken_review_app;
GRANT EXECUTE ON FUNCTION walshken_private.task_review_maintenance() TO walshken_review_app;
-- pg_cron already exists in this project for calling maintenance.
SELECT cron.schedule('walshken-task-preview-maintenance','*/5 * * * *','SELECT walshken_private.task_review_maintenance();');
