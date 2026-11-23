-- Never grant production payroll workflow writes for a Preview release.
GRANT SELECT,INSERT,UPDATE ON payroll,payroll_periods,payroll_settings,payroll_permissions,payroll_openings,payroll_earnings,payroll_reconciliations TO walshken_review_app;
GRANT SELECT,INSERT ON payroll_members,compensation,payroll_profiles,payroll_payments,payroll_events TO walshken_review_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON payroll_sources TO walshken_review_app;
GRANT UPDATE(voided_at) ON compensation TO walshken_review_app;
DO $payroll_preview$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['payroll_members','payroll','payroll_periods','payroll_settings','payroll_permissions','payroll_profiles','payroll_openings','payroll_earnings','payroll_sources','payroll_reconciliations','payroll_payments','payroll_events'] LOOP
  EXECUTE format('CREATE POLICY payroll_preview_runtime ON public.%I TO walshken_review_app USING(org_id=''walshken'' AND release_stage=''preview'') WITH CHECK(org_id=''walshken'' AND release_stage=''preview'')',t);
 END LOOP;
END;
$payroll_preview$;
CREATE POLICY payroll_preview_compensation ON compensation TO walshken_review_app USING(release_stage='preview' AND EXISTS(SELECT 1 FROM employees e WHERE e.id=employee_id AND e.org_id='walshken')) WITH CHECK(release_stage='preview' AND EXISTS(SELECT 1 FROM employees e WHERE e.id=employee_id AND e.org_id='walshken'));
CREATE POLICY payroll_preview_notifications ON notifications FOR INSERT TO walshken_review_app WITH CHECK(release_stage='preview' AND href IN('/staff/salary','/staff/payroll') AND EXISTS(SELECT 1 FROM employees e WHERE e.id=employee_id AND e.org_id='walshken'));
CREATE POLICY payroll_preview_integration_select ON integrations FOR SELECT TO walshken_review_app USING(id='payroll-calculator-review');
CREATE POLICY payroll_preview_integration_insert ON integrations FOR INSERT TO walshken_review_app WITH CHECK(id='payroll-calculator-review');
CREATE POLICY payroll_preview_integration_update ON integrations FOR UPDATE TO walshken_review_app USING(id='payroll-calculator-review') WITH CHECK(id='payroll-calculator-review');

-- Inherited Part B policies must not allow this Preview login to access production rates.
CREATE POLICY payroll_review_rate_isolation ON compensation AS RESTRICTIVE TO walshken_review_app USING(release_stage='preview') WITH CHECK(release_stage='preview');
CREATE POLICY payroll_review_ledger_isolation ON payroll AS RESTRICTIVE TO walshken_review_app USING(release_stage='preview') WITH CHECK(release_stage='preview');
