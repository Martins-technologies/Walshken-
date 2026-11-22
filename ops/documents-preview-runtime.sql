-- Separate preview runtime; password is provisioned through the secret store, never committed.
GRANT CONNECT ON DATABASE postgres TO walshken_review_app;
GRANT USAGE ON SCHEMA public TO walshken_review_app;
GRANT SELECT,INSERT,UPDATE ON public.doc_folders,public.doc_entries TO walshken_review_app;
GRANT SELECT,INSERT ON public.doc_versions,public.doc_events TO walshken_review_app;
GRANT SELECT,INSERT,DELETE ON public.doc_acl,public.doc_object_cleanup TO walshken_review_app;
DO $document_policies$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['doc_folders','doc_entries','doc_versions','doc_acl','doc_events','doc_object_cleanup'] LOOP
  EXECUTE format('CREATE POLICY documents_preview_runtime ON public.%I TO walshken_review_app USING(org_id=''walshken'') WITH CHECK(org_id=''walshken'')',t);
 END LOOP;
END;
$document_policies$;
GRANT SELECT ON public.services,public.markets,public.availability,public.site_content TO walshken_review_app;
CREATE POLICY documents_preview_catalog ON public.services FOR SELECT TO walshken_review_app USING(true);
CREATE POLICY documents_preview_catalog ON public.markets FOR SELECT TO walshken_review_app USING(true);
CREATE POLICY documents_preview_catalog ON public.availability FOR SELECT TO walshken_review_app USING(true);
CREATE POLICY documents_preview_catalog ON public.site_content FOR SELECT TO walshken_review_app USING(true);
CREATE POLICY documents_preview_integration ON public.integrations TO walshken_review_app USING(id='document-storage-review') WITH CHECK(id='document-storage-review');
CREATE POLICY documents_preview_notification ON public.notifications FOR INSERT TO walshken_review_app
 WITH CHECK(href LIKE '/staff/documents?document=%' AND EXISTS(SELECT 1 FROM public.employees e WHERE e.id=employee_id AND e.org_id='walshken'));
