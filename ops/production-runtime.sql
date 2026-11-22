-- Runtime login is provisioned separately with a random password in the environment secret store.
-- Inherit the existing staff/collaboration policies, and add the public site and customer paths.
GRANT walshken_preview_app TO walshken_production_app;
GRANT CONNECT ON DATABASE postgres TO walshken_production_app;
GRANT USAGE ON SCHEMA public TO walshken_production_app;
DO $public_site$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['services','markets','availability','site_content'] LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.%I TO walshken_production_app',t);
    EXECUTE format('CREATE POLICY walshken_production_site ON public.%I TO walshken_production_app USING(true) WITH CHECK(true)',t);
  END LOOP;
END;
$public_site$;
GRANT SELECT,INSERT,UPDATE ON public.customers TO walshken_production_app;
GRANT SELECT,INSERT,DELETE ON public.customer_sessions TO walshken_production_app;
GRANT SELECT,INSERT,UPDATE ON public.inquiries TO walshken_production_app;
CREATE POLICY walshken_production_customers ON public.customers TO walshken_production_app USING(true) WITH CHECK(true);
CREATE POLICY walshken_production_customer_sessions ON public.customer_sessions TO walshken_production_app USING(true) WITH CHECK(true);
CREATE POLICY walshken_production_inquiries ON public.inquiries TO walshken_production_app USING(true) WITH CHECK(true);
GRANT SELECT ON public.holidays,public.leave_requests TO walshken_production_app;
CREATE POLICY walshken_production_calendar ON public.holidays FOR SELECT TO walshken_production_app USING(org_id='walshken');
CREATE POLICY walshken_production_calendar ON public.leave_requests FOR SELECT TO walshken_production_app USING(org_id='walshken');
GRANT INSERT ON public.projects TO walshken_production_app;
CREATE POLICY walshken_production_projects ON public.projects FOR INSERT TO walshken_production_app
  WITH CHECK(org_id='walshken' AND EXISTS(SELECT 1 FROM public.employees e WHERE e.id=owner_id AND e.org_id='walshken'));

REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC,anon,authenticated;
