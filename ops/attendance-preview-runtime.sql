-- Enable Part F only for the existing branch-scoped review connection.
GRANT SELECT,INSERT,UPDATE ON attendance,breaks,shifts,timesheets,corrections,leave_requests,holidays,work_policies,shift_swaps,attendance_absences TO walshken_review_app;
GRANT SELECT,INSERT ON shift_series,work_events,work_reminders TO walshken_review_app;
DO $work_preview$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['attendance','shifts','timesheets','leave_requests','holidays','work_policies','shift_series','shift_swaps','attendance_absences','work_events','work_reminders'] LOOP
  EXECUTE format('CREATE POLICY work_preview_runtime ON public.%I TO walshken_review_app USING(org_id=''walshken'' AND release_stage=''preview'') WITH CHECK(org_id=''walshken'' AND release_stage=''preview'')',t);
 END LOOP;
END;
$work_preview$;
CREATE POLICY work_preview_breaks ON breaks TO walshken_review_app USING(release_stage='preview' AND EXISTS(SELECT 1 FROM attendance a WHERE a.id=attendance_id AND a.org_id='walshken' AND a.release_stage='preview')) WITH CHECK(release_stage='preview' AND EXISTS(SELECT 1 FROM attendance a WHERE a.id=attendance_id AND a.org_id='walshken' AND a.release_stage='preview'));
CREATE POLICY work_preview_corrections ON corrections TO walshken_review_app USING(release_stage='preview' AND EXISTS(SELECT 1 FROM employees e WHERE e.id=employee_id AND e.org_id='walshken')) WITH CHECK(release_stage='preview' AND EXISTS(SELECT 1 FROM employees e WHERE e.id=employee_id AND e.org_id='walshken'));
CREATE POLICY work_preview_notifications ON notifications FOR INSERT TO walshken_review_app WITH CHECK(release_stage='preview' AND href LIKE '/staff/%' AND EXISTS(SELECT 1 FROM employees e WHERE e.id=employee_id AND e.org_id='walshken'));
