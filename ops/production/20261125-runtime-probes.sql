-- Run after the migration. Every inserted row is synthetic and rolled back.
-- This script changes no account, MFA factor, credential, existing record, or
-- external object. It uses the real non-owner production role and RLS policies.
BEGIN;
SET LOCAL search_path=public,pg_catalog;
SET LOCAL statement_timeout='45s';
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE walshken_production_app;
DO $runtime_probe$
DECLARE
 actor text; reviewer text; tag text='release-probe-'||gen_random_uuid()::text;
 audit_id text; other_audit_id text; payroll_id text; security_id text; request_id text;
 at_time text=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 before_row jsonb; row_hash text; n bigint; blocked boolean; t text;
BEGIN
 IF current_user<>'walshken_production_app' THEN RAISE EXCEPTION 'Probe is not running as the actual non-owner role';END IF;
 SELECT id INTO actor FROM public.employees WHERE org_id='walshken' ORDER BY id LIMIT 1;
 SELECT id INTO reviewer FROM public.employees WHERE org_id='walshken' AND id<>actor ORDER BY id LIMIT 1;
 IF actor IS NULL OR reviewer IS NULL THEN RAISE EXCEPTION 'Two existing actor references required';END IF;
 IF EXISTS(SELECT 1 FROM public.employees WHERE org_id<>'walshken') THEN RAISE EXCEPTION 'Cross-organization personnel visibility';END IF;
 IF EXISTS(SELECT 1 FROM public.payroll WHERE release_stage<>'production') THEN RAISE EXCEPTION 'Preview payroll visibility';END IF;
 IF has_schema_privilege(current_user,'walshken_role_qa','USAGE') THEN RAISE EXCEPTION 'Cross-schema privilege';END IF;

 FOREACH t IN ARRAY ARRAY['staff_action_permissions','staff_security_events','staff_privacy_notices','staff_privacy_acknowledgements','staff_reporting_reviews','staff_jurisdiction_versions','staff_jurisdiction_decisions','staff_work_policy_versions','employment_countries','employment_regions','staff_employment_terms','staff_upload_scans','staff_upload_scan_events','staff_leave_adjustments','staff_leave_adjustment_reviews','staff_retention_versions','staff_retention_reviews','staff_legal_holds','staff_legal_hold_releases','staff_statutory_inputs','staff_statutory_input_reviews','staff_contribution_ledger','staff_country_holiday_allocations','staff_privacy_requests','staff_privacy_request_events','staff_privacy_cleanup','staff_source_disposals','staff_source_disposal_items','staff_source_disposal_reviews','staff_source_disposal_events','staff_source_disposal_objects','staff_employer_versions','staff_employer_decisions','staff_employee_statutory_facts','staff_employee_statutory_reviews','staff_employer_levy_assessments','staff_employer_levy_reviews'] LOOP
  EXECUTE format('SELECT count(*) FROM public.%I',t) INTO n;
  IF has_table_privilege('anon','public.'||t,'SELECT') OR has_table_privilege('authenticated','public.'||t,'SELECT') THEN RAISE EXCEPTION 'Data API grant remains on %',t;END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.employment_countries WHERE org_id='walshken')<>3 OR (SELECT count(*) FROM public.employment_regions WHERE org_id='walshken')<>59 THEN RAISE EXCEPTION 'Geographic read failed';END IF;
 UPDATE public.employment_countries SET name=name WHERE org_id='walshken' AND code='CA';
 GET DIAGNOSTICS n=ROW_COUNT;IF n<>1 THEN RAISE EXCEPTION 'Mutable-table runtime update failed';END IF;

 audit_id=tag||'-audit'; other_audit_id=tag||'-audit-retain'; payroll_id=tag||'-payroll'; security_id=tag||'-security'; request_id=tag||'-disposal';
 INSERT INTO public.audit(id,org_id,actor_id,action,entity,target_id)
 VALUES(audit_id,'walshken',actor,'Synthetic rollback probe','release probe',tag),
       (other_audit_id,'walshken',actor,'Synthetic rollback probe','release probe',tag);
 INSERT INTO public.staff_security_events(id,org_id,employee_id,fingerprint,action,created_at)
 VALUES(security_id,'walshken',actor,tag,'Sign-in failed',at_time);
 INSERT INTO public.payroll(id,org_id,employee_id,starts_on,ends_on,currency,payable_seconds,gross_cents,status,calculation,created_by,workflow_version,release_stage)
 VALUES(payroll_id,'walshken',actor,'2000-01-01','2000-01-02','CAD',0,0,'Finalized','{}',actor,1,'production');

 -- These actual rows prove that lock-only UPDATE grants do not silently hide
 -- immutable source rows, which would otherwise invalidate disposal manifests.
 SELECT count(*) INTO n FROM(SELECT id FROM public.audit WHERE id=audit_id FOR UPDATE) locked;
 IF n<>1 THEN RAISE EXCEPTION 'Immutable audit row lock returned no row';END IF;
 SELECT count(*) INTO n FROM(SELECT id FROM public.staff_security_events WHERE id=security_id FOR UPDATE) locked;
 IF n<>1 THEN RAISE EXCEPTION 'Immutable new-table row lock returned no row';END IF;
 FOREACH t IN ARRAY ARRAY['doc_versions','staff_employee_statutory_facts','staff_contribution_ledger'] LOOP
  EXECUTE format('SELECT count(*) FROM(SELECT * FROM public.%I WHERE false FOR UPDATE) locked',t) INTO n;
 END LOOP;

 -- The non-owner role cannot rewrite retained history or finalized payroll.
 blocked=false;
 BEGIN UPDATE public.audit SET id=id WHERE id=audit_id;
 EXCEPTION WHEN insufficient_privilege OR raise_exception THEN blocked=true;END;
 IF NOT blocked THEN RAISE EXCEPTION 'Audit mutation unexpectedly allowed';END IF;
 blocked=false;
 BEGIN UPDATE public.staff_security_events SET id=id WHERE id=security_id;
 EXCEPTION WHEN insufficient_privilege OR raise_exception THEN blocked=true;END;
 IF NOT blocked THEN RAISE EXCEPTION 'Security-history mutation unexpectedly allowed';END IF;
 blocked=false;
 BEGIN UPDATE public.payroll SET gross_cents=1 WHERE id=payroll_id;
 EXCEPTION WHEN insufficient_privilege OR raise_exception THEN blocked=true;END;
 IF NOT blocked THEN RAISE EXCEPTION 'Finalized-payroll mutation unexpectedly allowed';END IF;
 DELETE FROM public.audit WHERE id=audit_id;GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>0 THEN RAISE EXCEPTION 'Unapproved audit deletion unexpectedly allowed';END IF;
 DELETE FROM public.payroll WHERE id=payroll_id;GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>0 THEN RAISE EXCEPTION 'Unapproved payroll deletion unexpectedly allowed';END IF;

 -- New-table insertion must honor the organization/stage boundary.
 blocked=false;
 BEGIN INSERT INTO public.staff_security_events(id,org_id,employee_id,fingerprint,action,created_at)
 VALUES(tag||'-outside','outside-walshken',actor,tag,'Sign-in failed',at_time);
 EXCEPTION WHEN insufficient_privilege THEN blocked=true;END;
 IF NOT blocked THEN RAISE EXCEPTION 'Cross-organization insert unexpectedly allowed';END IF;
 blocked=false;
 BEGIN INSERT INTO public.staff_work_policy_versions(id,org_id,employee_id,release_stage,effective_on,revision,settings,created_by,created_at)
 VALUES(tag||'-preview','walshken',actor,'preview','2000-01-01',987654,'{}',actor,at_time);
 EXCEPTION WHEN insufficient_privilege THEN blocked=true;END;
 IF NOT blocked THEN RAISE EXCEPTION 'Preview-stage insert unexpectedly allowed';END IF;

 -- Only the exact approved frozen audit row may pass the new delete privilege.
 SELECT to_jsonb(a),encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex') INTO before_row,row_hash FROM public.audit a WHERE id=audit_id;
 INSERT INTO public.staff_source_disposals(id,org_id,employee_id,release_stage,category,from_date,through_date,reason,manifest_time,manifest_hash,manifest_count,state,created_by,created_at,executed_by,executed_at)
 VALUES(request_id,'walshken',actor,'production','Audit history','2000-01-01','2000-01-02','Synthetic rollback probe only',at_time,tag,1,'Executing',actor,at_time,actor,at_time);
 INSERT INTO public.staff_source_disposal_items(id,request_id,table_name,record_key,before_hash,operation,category,owner_ids,countries,anchor_date,eligible_after,hold_targets,summary)
 VALUES(tag||'-item',request_id,'audit',jsonb_build_object('id',audit_id),row_hash,'Delete','Audit history',jsonb_build_array(actor),jsonb_build_array('CA'),'2000-01-01','2000-01-02','[]'::jsonb,'Synthetic rollback fixture');
 INSERT INTO public.staff_source_disposal_reviews(id,request_id,decision,actor_id,reason,created_at)
 VALUES(tag||'-review',request_id,'Approved',reviewer,'Synthetic rollback probe only',at_time);
 PERFORM set_config('walshken.source_disposal',request_id,true);
 PERFORM set_config('walshken.source_disposal_actor',actor,true);
 IF NOT public.walshken_source_disposal_allowed('audit',before_row,NULL::jsonb) THEN RAISE EXCEPTION 'Approved exact manifest not recognized';END IF;
 DELETE FROM public.audit WHERE id=other_audit_id;GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>0 THEN RAISE EXCEPTION 'Approved request authorized an unrelated audit row';END IF;
 DELETE FROM public.audit WHERE id=audit_id;GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'Approved exact-manifest delete did not execute';END IF;
 PERFORM set_config('walshken.source_disposal','',true);
 PERFORM set_config('walshken.source_disposal_actor','',true);
 IF NOT EXISTS(SELECT 1 FROM public.audit WHERE id=other_audit_id) OR NOT EXISTS(SELECT 1 FROM public.payroll WHERE id=payroll_id AND gross_cents=0 AND status='Finalized') THEN RAISE EXCEPTION 'Unrelated fixture changed';END IF;
END;
$runtime_probe$;
ROLLBACK;
SELECT 'PASS: non-owner runtime/RLS/row-lock/history/finalized-payroll/exact-manifest checks; all synthetic fixtures rolled back' AS result;
