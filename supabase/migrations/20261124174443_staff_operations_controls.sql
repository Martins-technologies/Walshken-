CREATE TABLE operating_grants (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), release_stage text NOT NULL CHECK(release_stage IN('preview','production')),
 employee_id text NOT NULL REFERENCES employees(id), permission text NOT NULL, allowed integer NOT NULL CHECK(allowed IN(0,1)), scope text NOT NULL CHECK(scope IN('Assigned','Organization')),
 revision integer NOT NULL DEFAULT 1, updated_by text NOT NULL REFERENCES employees(id), updated_at text NOT NULL,
 UNIQUE(employee_id,release_stage,permission)
);
--> statement-breakpoint
CREATE TABLE work_policy_versions (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), release_stage text NOT NULL CHECK(release_stage IN('preview','production')), employee_id text NOT NULL REFERENCES employees(id),
 effective_on text NOT NULL, settings text NOT NULL, reference text NOT NULL, created_by text NOT NULL REFERENCES employees(id), created_at text NOT NULL
);
--> statement-breakpoint
CREATE TABLE operations_requests (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), release_stage text NOT NULL CHECK(release_stage IN('preview','production')),
 employee_id text REFERENCES employees(id), kind text NOT NULL CHECK(kind IN('Reporting classification','Overtime banking','Overtime leave','Averaging arrangement','Vacation opening','Vacation adjustment','Jurisdiction package','Withdraw arrangement')),
 configuration text NOT NULL, effective_on text NOT NULL, through_date text NOT NULL, status text NOT NULL DEFAULT 'Draft' CHECK(status IN('Draft','Submitted','Approved','Rejected','Cancelled')),
 revision integer NOT NULL DEFAULT 1, reference text NOT NULL, created_by text NOT NULL REFERENCES employees(id), created_at text NOT NULL, updated_at text NOT NULL,
 consented_by text REFERENCES employees(id), consented_at text, reviewed_by text REFERENCES employees(id), reviewed_at text, review_note text NOT NULL DEFAULT ''
);
CREATE INDEX operations_requests_scope ON operations_requests(org_id,release_stage,employee_id,kind,status,effective_on);
--> statement-breakpoint
CREATE TABLE operations_ledger (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), release_stage text NOT NULL CHECK(release_stage IN('preview','production')), employee_id text NOT NULL REFERENCES employees(id),
 kind text NOT NULL CHECK(kind IN('Overtime credit','Overtime leave','Overtime settlement','Vacation entitlement','Vacation used','Vacation opening','Vacation adjustment')),
 source_id text NOT NULL, effective_on text NOT NULL, due_on text, seconds integer NOT NULL, amount_minor integer NOT NULL DEFAULT 0, currency text NOT NULL DEFAULT '', detail text NOT NULL,
 created_by text NOT NULL REFERENCES employees(id), created_at text NOT NULL, UNIQUE(release_stage,employee_id,kind,source_id)
);
CREATE INDEX operations_ledger_employee ON operations_ledger(org_id,release_stage,employee_id,effective_on);
--> statement-breakpoint
CREATE TABLE operations_settings (
 org_id text NOT NULL REFERENCES organizations(id), release_stage text NOT NULL CHECK(release_stage IN('preview','production')), settings text NOT NULL, revision integer NOT NULL DEFAULT 1,
 updated_by text NOT NULL REFERENCES employees(id), updated_at text NOT NULL, PRIMARY KEY(org_id,release_stage)
);
--> statement-breakpoint
CREATE TABLE operations_audit (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), release_stage text NOT NULL CHECK(release_stage IN('preview','production')), actor_id text NOT NULL REFERENCES employees(id),
 action text NOT NULL, target_id text NOT NULL, before_value text NOT NULL, after_value text NOT NULL, created_at text NOT NULL
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION operations_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME IN ('operations_ledger','operations_audit','work_policy_versions') THEN RAISE EXCEPTION 'Approved operations history is immutable; create an auditable replacement'; END IF;
 IF TG_TABLE_NAME='operations_requests' THEN IF OLD.status='Approved' THEN RAISE EXCEPTION 'Approved operations history is immutable; create an auditable replacement'; END IF; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER protect_operations_request BEFORE UPDATE OR DELETE ON operations_requests FOR EACH ROW EXECUTE FUNCTION operations_history_guard();
CREATE TRIGGER protect_operations_ledger BEFORE UPDATE OR DELETE ON operations_ledger FOR EACH ROW EXECUTE FUNCTION operations_history_guard();
CREATE TRIGGER protect_operations_audit BEFORE UPDATE OR DELETE ON operations_audit FOR EACH ROW EXECUTE FUNCTION operations_history_guard();
CREATE TRIGGER protect_work_policy_versions BEFORE UPDATE OR DELETE ON work_policy_versions FOR EACH ROW EXECUTE FUNCTION operations_history_guard();
--> statement-breakpoint
ALTER TABLE operating_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON operating_grants,work_policy_versions,operations_requests,operations_ledger,operations_settings,operations_audit FROM anon,authenticated;
