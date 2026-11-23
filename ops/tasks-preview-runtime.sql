-- Part E Preview runtime. Production is not granted task workflow write access.
GRANT SELECT,INSERT,UPDATE ON public.tasks TO walshken_review_app;
CREATE POLICY tasks_preview_write ON public.tasks TO walshken_review_app
 USING(org_id='walshken' AND release_stage='preview') WITH CHECK(org_id='walshken' AND release_stage='preview' AND workflow_version=1);
GRANT SELECT,INSERT ON public.task_notes,public.task_reviews,public.task_events,public.task_overdue_alerts TO walshken_review_app;
GRANT SELECT,INSERT,UPDATE ON public.task_time_entries TO walshken_review_app;
GRANT SELECT,INSERT,UPDATE(deleted_at) ON public.task_files TO walshken_review_app;
GRANT SELECT,INSERT,DELETE ON public.task_document_links,public.task_file_cleanup TO walshken_review_app;
DO $task_preview_policies$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['task_notes','task_time_entries','task_files','task_document_links','task_reviews','task_events','task_overdue_alerts'] LOOP
  EXECUTE format('CREATE POLICY tasks_preview_runtime ON public.%I TO walshken_review_app USING(org_id=''walshken'' AND EXISTS(SELECT 1 FROM public.tasks t WHERE t.id=task_id AND t.release_stage=''preview'')) WITH CHECK(org_id=''walshken'' AND EXISTS(SELECT 1 FROM public.tasks t WHERE t.id=task_id AND t.release_stage=''preview''))',t);
 END LOOP;
END;
$task_preview_policies$;
CREATE POLICY tasks_preview_cleanup ON public.task_file_cleanup TO walshken_review_app USING(org_id='walshken') WITH CHECK(org_id='walshken');
GRANT INSERT(id,employee_id,title,body,href,release_stage) ON public.notifications TO walshken_review_app;
CREATE POLICY tasks_preview_notifications ON public.notifications FOR INSERT TO walshken_review_app
 WITH CHECK(release_stage='preview' AND href LIKE '/staff/tasks?task=%' AND EXISTS(SELECT 1 FROM public.employees e WHERE e.id=employee_id AND e.org_id='walshken'));
