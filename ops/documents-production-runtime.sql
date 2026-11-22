-- Owner-approved Part D production release. Preserve existing files, ACLs and private storage.
-- Grant only the document runtime operations; audit and version rows remain append-only.
GRANT SELECT,INSERT,UPDATE ON public.doc_folders,public.doc_entries TO walshken_production_app;
GRANT SELECT,INSERT ON public.doc_versions,public.doc_events TO walshken_production_app;
GRANT SELECT,INSERT,DELETE ON public.doc_acl,public.doc_object_cleanup TO walshken_production_app;
DO $document_production_policies$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['doc_folders','doc_entries','doc_versions','doc_acl','doc_events','doc_object_cleanup'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='documents_production_runtime') THEN
   EXECUTE format('CREATE POLICY documents_production_runtime ON public.%I TO walshken_production_app USING(org_id=''walshken'') WITH CHECK(org_id=''walshken'')',t);
  END IF;
 END LOOP;
END;
$document_production_policies$;
DO $document_production_integration$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='integrations' AND policyname='documents_production_integration') THEN
  CREATE POLICY documents_production_integration ON public.integrations TO walshken_production_app
   USING(id='document-storage-review') WITH CHECK(id='document-storage-review');
 END IF;
END;
$document_production_integration$;
GRANT INSERT(id,employee_id,title,body,href) ON public.notifications TO walshken_production_app;
DO $document_production_notification$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notifications' AND policyname='documents_production_notification') THEN
  CREATE POLICY documents_production_notification ON public.notifications FOR INSERT TO walshken_production_app
   WITH CHECK(href LIKE '/staff/documents?document=%' AND EXISTS(SELECT 1 FROM public.employees e WHERE e.id=employee_id AND e.org_id='walshken'));
 END IF;
END;
$document_production_notification$;
