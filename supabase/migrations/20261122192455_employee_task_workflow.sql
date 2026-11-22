-- Extend the canonical task records; keep Preview rows invisible to the live runtime.
ALTER TABLE public.tasks ADD COLUMN release_stage text NOT NULL DEFAULT 'production' CHECK(release_stage IN('preview','production'));
ALTER TABLE public.tasks ADD COLUMN workflow_version integer NOT NULL DEFAULT 0;
ALTER TABLE public.tasks ADD COLUMN department_id text REFERENCES public.units(id);
ALTER TABLE public.tasks ADD COLUMN division_id text REFERENCES public.units(id);
ALTER TABLE public.tasks ADD COLUMN client_reference text NOT NULL DEFAULT '';
ALTER TABLE public.tasks ADD COLUMN reviewer_id text REFERENCES public.employees(id);
ALTER TABLE public.tasks ADD COLUMN approval_status text NOT NULL DEFAULT 'Not submitted' CHECK(approval_status IN('Not submitted','Pending','Approved','Changes requested','Cancelled'));
ALTER TABLE public.tasks ADD COLUMN progress integer NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100);
ALTER TABLE public.tasks ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.tasks ADD COLUMN submitted_at text;
ALTER TABLE public.tasks ADD COLUMN reviewed_at text;
ALTER TABLE public.tasks ADD COLUMN review_note text NOT NULL DEFAULT '';
ALTER TABLE public.tasks ADD COLUMN updated_at text NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
ALTER TABLE public.tasks ADD COLUMN task_timezone text NOT NULL DEFAULT 'UTC';
ALTER TABLE public.notifications ADD COLUMN release_stage text NOT NULL DEFAULT 'production' CHECK(release_stage IN('preview','production'));
CREATE INDEX tasks_workflow_dashboard ON public.tasks(org_id,release_stage,employee_id,status,due_date);
CREATE INDEX tasks_workflow_reviewer ON public.tasks(org_id,release_stage,reviewer_id,approval_status);
CREATE TABLE public.task_notes(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),task_id text NOT NULL REFERENCES tasks(id),author_id text NOT NULL REFERENCES employees(id),body text NOT NULL,created_at text NOT NULL);
CREATE INDEX task_notes_thread ON public.task_notes(task_id,created_at,id);
CREATE TABLE public.task_time_entries(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),task_id text NOT NULL REFERENCES tasks(id),employee_id text NOT NULL REFERENCES employees(id),kind text NOT NULL CHECK(kind IN('Manual','Timer')),worked_on text NOT NULL,starts_at text,ends_at text,seconds integer NOT NULL DEFAULT 0 CHECK(seconds BETWEEN 0 AND 43200),note text NOT NULL DEFAULT '',voided_at text,created_at text NOT NULL,updated_at text NOT NULL,
 CHECK(kind='Manual' OR starts_at IS NOT NULL),CHECK(kind='Timer' OR (starts_at IS NULL AND ends_at IS NOT NULL)));
CREATE UNIQUE INDEX task_one_running_timer ON public.task_time_entries(employee_id) WHERE kind='Timer' AND ends_at IS NULL AND voided_at IS NULL;
CREATE INDEX task_time_totals ON public.task_time_entries(task_id,voided_at);
CREATE TABLE public.task_files(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),task_id text NOT NULL REFERENCES tasks(id),uploaded_by text NOT NULL REFERENCES employees(id),filename text NOT NULL,mime text NOT NULL,bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 3145728),sha256 text NOT NULL,storage_key text NOT NULL UNIQUE,page_count integer NOT NULL CHECK(page_count BETWEEN 1 AND 200),created_at text NOT NULL,deleted_at text);
CREATE INDEX task_files_task ON public.task_files(task_id,created_at);
CREATE TABLE public.task_file_cleanup(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),storage_key text NOT NULL UNIQUE,created_at text NOT NULL);
CREATE TABLE public.task_document_links(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),task_id text NOT NULL REFERENCES tasks(id),document_id text NOT NULL REFERENCES doc_entries(id),created_by text NOT NULL REFERENCES employees(id),created_at text NOT NULL,UNIQUE(task_id,document_id));
CREATE TABLE public.task_reviews(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),task_id text NOT NULL REFERENCES tasks(id),actor_id text NOT NULL REFERENCES employees(id),decision text NOT NULL,note text NOT NULL,task_revision integer NOT NULL,created_at text NOT NULL);
CREATE TABLE public.task_events(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),task_id text NOT NULL REFERENCES tasks(id),actor_id text REFERENCES employees(id),action text NOT NULL,detail text NOT NULL DEFAULT '',created_at text NOT NULL);
CREATE INDEX task_events_history ON public.task_events(task_id,created_at DESC,id);
CREATE TABLE public.task_overdue_alerts(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),task_id text NOT NULL REFERENCES tasks(id),employee_id text NOT NULL REFERENCES employees(id),alert_day text NOT NULL,due_date text NOT NULL,created_at text NOT NULL,UNIQUE(task_id,employee_id,alert_day,due_date));
DO $task_guards$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['task_notes','task_time_entries','task_files','task_file_cleanup','task_document_links','task_reviews','task_events','task_overdue_alerts'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON public.%I FROM anon',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON public.%I FROM authenticated',t); END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='walshken_production_app') THEN
  CREATE POLICY task_preview_isolation ON public.tasks AS RESTRICTIVE TO walshken_production_app USING(release_stage='production') WITH CHECK(release_stage='production');
  CREATE POLICY task_notification_preview_isolation ON public.notifications AS RESTRICTIVE TO walshken_production_app USING(release_stage='production') WITH CHECK(release_stage='production');
 END IF;
END;
$task_guards$;
