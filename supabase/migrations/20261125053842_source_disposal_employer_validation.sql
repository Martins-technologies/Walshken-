-- Apply to the isolated review schema first. Original history remains immutable
-- except for a separately approved, exact-hash source-disposal manifest.
CREATE TABLE staff_source_disposals(
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),employee_id text NOT NULL REFERENCES employees(id),release_stage text NOT NULL,
 category text NOT NULL,from_date text NOT NULL,through_date text NOT NULL,reason text NOT NULL,
 manifest_time text NOT NULL,manifest_hash text NOT NULL,manifest_count integer NOT NULL CHECK(manifest_count>0),
 state text NOT NULL DEFAULT 'Pending' CHECK(state IN('Pending','Approved','Rejected','Executing','Cleanup pending','Completed','Cancelled')),
 revision integer NOT NULL DEFAULT 1,created_by text NOT NULL REFERENCES employees(id),created_at text NOT NULL,
 executed_by text REFERENCES employees(id),executed_at text,completed_at text
);
CREATE INDEX source_disposal_recent ON staff_source_disposals(org_id,release_stage,created_at DESC);
CREATE TABLE staff_source_disposal_items(
 id text PRIMARY KEY,request_id text NOT NULL REFERENCES staff_source_disposals(id),table_name text NOT NULL,record_key jsonb NOT NULL,
 before_hash text NOT NULL,after_hash text,patch jsonb,operation text NOT NULL CHECK(operation IN('Delete','Redact')),
 category text NOT NULL,owner_ids jsonb NOT NULL,countries jsonb NOT NULL,anchor_date text NOT NULL,eligible_after text NOT NULL,
 hold_targets jsonb NOT NULL,summary text NOT NULL,UNIQUE(request_id,table_name,record_key)
);
CREATE TABLE staff_source_disposal_reviews(
 id text PRIMARY KEY,request_id text NOT NULL UNIQUE REFERENCES staff_source_disposals(id),decision text NOT NULL CHECK(decision IN('Approved','Rejected')),
 actor_id text NOT NULL REFERENCES employees(id),reason text NOT NULL,created_at text NOT NULL
);
CREATE TABLE staff_source_disposal_events(
 id text PRIMARY KEY,request_id text NOT NULL REFERENCES staff_source_disposals(id),actor_id text NOT NULL REFERENCES employees(id),action text NOT NULL,detail text NOT NULL,created_at text NOT NULL
);
CREATE INDEX source_disposal_events_request ON staff_source_disposal_events(request_id,created_at,id);
CREATE TABLE staff_source_disposal_objects(
 id text PRIMARY KEY,request_id text NOT NULL REFERENCES staff_source_disposals(id),storage_kind text NOT NULL CHECK(storage_kind IN('Documents','Recordings')),
 storage_id text NOT NULL,storage_key text NOT NULL,storage_location jsonb NOT NULL,attempts integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'Pending' CHECK(status IN('Pending','Deleted')),
 last_error text,deleted_at text,UNIQUE(request_id,storage_kind,storage_id,storage_key)
);
CREATE TABLE staff_employer_versions(
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),country text NOT NULL CHECK(country IN('CA','IN','PK')),
 effective_from text NOT NULL,effective_through text NOT NULL,version text NOT NULL,configuration text NOT NULL,configuration_hash text NOT NULL,
 created_by text NOT NULL REFERENCES employees(id),created_at text NOT NULL,UNIQUE(org_id,country,version)
);
CREATE INDEX employer_version_lookup ON staff_employer_versions(org_id,country,effective_from DESC);
CREATE TABLE staff_employer_decisions(
 id text PRIMARY KEY,version_id text NOT NULL REFERENCES staff_employer_versions(id),decision text NOT NULL CHECK(decision IN('Approved','Rejected','Withdrawn')),
 actor_id text NOT NULL REFERENCES employees(id),reason text NOT NULL,created_at text NOT NULL
);
CREATE TABLE staff_employee_statutory_facts(
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),employee_id text NOT NULL REFERENCES employees(id),
 effective_from text NOT NULL,effective_through text NOT NULL,configuration text NOT NULL,configuration_hash text NOT NULL,
 created_by text NOT NULL REFERENCES employees(id),created_at text NOT NULL
);
CREATE TABLE staff_employee_statutory_reviews(
 id text PRIMARY KEY,facts_id text NOT NULL UNIQUE REFERENCES staff_employee_statutory_facts(id),decision text NOT NULL CHECK(decision IN('Approved','Rejected')),
 actor_id text NOT NULL REFERENCES employees(id),reason text NOT NULL,created_at text NOT NULL
);
CREATE TABLE staff_employer_levy_assessments(
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),period_id text NOT NULL REFERENCES payroll_periods(id),release_stage text NOT NULL,
 country text NOT NULL,configuration_hash text NOT NULL,source_hash text NOT NULL,calculation text NOT NULL,
 created_by text NOT NULL REFERENCES employees(id),created_at text NOT NULL
);
CREATE TABLE staff_employer_levy_reviews(
 id text PRIMARY KEY,assessment_id text NOT NULL UNIQUE REFERENCES staff_employer_levy_assessments(id),decision text NOT NULL CHECK(decision IN('Approved','Rejected')),
 actor_id text NOT NULL REFERENCES employees(id),reason text NOT NULL,created_at text NOT NULL
);

CREATE FUNCTION walshken_source_disposal_allowed(tab text,before_row jsonb,after_row jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path FROM CURRENT AS $guard$
 SELECT EXISTS(
 SELECT 1 FROM staff_source_disposals r JOIN staff_source_disposal_items i ON i.request_id=r.id
 JOIN staff_source_disposal_reviews v ON v.request_id=r.id AND v.decision='Approved' AND v.actor_id<>r.created_by
 WHERE r.id=current_setting('walshken.source_disposal',true) AND r.state='Executing'
 AND r.executed_by=current_setting('walshken.source_disposal_actor',true)
 AND i.table_name=tab AND before_row @> i.record_key
 AND i.before_hash=encode(sha256(convert_to(before_row::text,'UTF8')),'hex')
 AND ((i.operation='Delete' AND after_row IS NULL) OR(i.operation='Redact' AND i.after_hash=encode(sha256(convert_to(after_row::text,'UTF8')),'hex')))
 AND i.eligible_after<=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD')
 AND NOT EXISTS(SELECT 1 FROM staff_legal_holds h WHERE h.org_id=r.org_id
  AND NOT EXISTS(SELECT 1 FROM staff_legal_hold_releases x WHERE x.hold_id=h.id)
  AND (h.scope_type='organization' OR(h.scope_type='employee' AND i.owner_ids ? h.target_id)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(i.hold_targets) a WHERE a->>'type'=h.scope_type AND a->>'id'=h.target_id)))
 );
$guard$;
REVOKE ALL ON FUNCTION walshken_source_disposal_allowed(text,jsonb,jsonb) FROM PUBLIC;

-- Preserve every existing business/history guard; add one narrow checked exit.
DO $wrap$
DECLARE p record;body text;definition text;prefix text;
BEGIN
 FOR p IN SELECT DISTINCT f.oid,f.prosrc,f.proname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc f ON f.oid=t.tgfoid
 WHERE n.nspname=current_schema() AND NOT t.tgisinternal AND c.relname IN
 ('audit','compensation','payroll','payroll_sources','payroll_payments','payroll_profiles','payroll_openings','payroll_earnings','payroll_members','payroll_events','holiday_allocations','holiday_assessments','holiday_assignments','holiday_audit','holiday_consents','holiday_exceptions','holiday_histories','holiday_private_records','staff_employment_terms','staff_reporting_reviews','staff_work_policy_versions','staff_leave_adjustments','staff_leave_adjustment_reviews','staff_contribution_ledger','staff_country_holiday_allocations','staff_statutory_inputs','staff_statutory_input_reviews','staff_security_events')
 LOOP
  IF position('walshken_source_disposal_allowed' IN p.prosrc)>0 THEN CONTINUE;END IF;
  prefix=format(E'BEGIN\n IF TG_OP=''DELETE'' AND %I.walshken_source_disposal_allowed(TG_TABLE_NAME::text,to_jsonb(OLD),NULL::jsonb) THEN RETURN OLD;END IF;\n IF TG_OP=''UPDATE'' AND %I.walshken_source_disposal_allowed(TG_TABLE_NAME::text,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;',current_schema(),current_schema());
  body=regexp_replace(p.prosrc,'\mBEGIN\M',prefix, 'i');
  IF body=p.prosrc THEN RAISE EXCEPTION 'Unsupported source guard %',p.proname;END IF;
  definition=replace(pg_get_functiondef(p.oid),p.prosrc,body);EXECUTE definition;
 END LOOP;
END;
$wrap$;

DO $security$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['staff_source_disposal_items','staff_source_disposal_reviews','staff_source_disposal_events','staff_employer_versions','staff_employer_decisions','staff_employee_statutory_facts','staff_employee_statutory_reviews','staff_employer_levy_assessments','staff_employer_levy_reviews'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_source_validation_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION walshken_reject_history_mutation()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['staff_source_disposals','staff_source_disposal_items','staff_source_disposal_reviews','staff_source_disposal_events','staff_source_disposal_objects','staff_employer_versions','staff_employer_decisions','staff_employee_statutory_facts','staff_employee_statutory_reviews','staff_employer_levy_assessments','staff_employer_levy_reviews'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC,anon,authenticated',t);
 END LOOP;
END;
$security$;
