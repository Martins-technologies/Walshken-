-- Enable Part H only for the approved review runtime; production receives no new grants.
GRANT SELECT,INSERT ON holiday_rules,holiday_assignments,holiday_event_versions,holiday_allocations,holiday_private_records,holiday_consents,holiday_audit TO walshken_review_app;
GRANT SELECT,INSERT,UPDATE ON holiday_company_events,holiday_histories,holiday_exceptions,holiday_assessments,holiday_reconciliations TO walshken_review_app;
DO $holiday_preview$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['holiday_rules','holiday_assignments','holiday_company_events','holiday_event_versions','holiday_histories','holiday_exceptions','holiday_assessments','holiday_allocations','holiday_reconciliations','holiday_private_records','holiday_consents','holiday_audit'] LOOP
  EXECUTE format('CREATE POLICY holiday_preview_runtime ON public.%I TO walshken_review_app USING(org_id=''walshken'' AND release_stage=''preview'') WITH CHECK(org_id=''walshken'' AND release_stage=''preview'')',t);
 END LOOP;
END;
$holiday_preview$;
