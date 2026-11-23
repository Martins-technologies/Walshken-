ALTER TABLE compensation ADD COLUMN release_stage text NOT NULL DEFAULT 'production' CHECK(release_stage IN('preview','production'));
ALTER TABLE compensation ADD COLUMN workflow_version integer NOT NULL DEFAULT 0;
ALTER TABLE compensation ADD COLUMN minor_unit integer NOT NULL DEFAULT 2 CHECK(minor_unit BETWEEN 0 AND 3);
ALTER TABLE compensation ADD COLUMN rate_unit text NOT NULL DEFAULT 'Hour' CHECK(rate_unit IN('Hour','Year','Period'));
ALTER TABLE compensation ADD COLUMN note text NOT NULL DEFAULT '';
ALTER TABLE compensation ADD COLUMN voided_at text;
DROP INDEX compensation_employee_date;
CREATE UNIQUE INDEX compensation_employee_date ON compensation(employee_id,release_stage,effective_on) WHERE voided_at IS NULL;
CREATE TABLE payroll_periods(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),release_stage text NOT NULL CHECK(release_stage IN('preview','production')),label text NOT NULL,frequency text NOT NULL CHECK(frequency IN('Weekly','Biweekly','Semimonthly','Monthly')),starts_on text NOT NULL,ends_on text NOT NULL,pay_date text NOT NULL,periods_per_year integer NOT NULL,status text NOT NULL DEFAULT 'Draft' CHECK(status IN('Draft','Calculated','Submitted','Approved','Finalized','Cancelled')),revision integer NOT NULL DEFAULT 1,created_by text NOT NULL REFERENCES employees(id),submitted_by text REFERENCES employees(id),finalized_by text REFERENCES employees(id),created_at text NOT NULL,updated_at text NOT NULL,submitted_at text,finalized_at text,note text NOT NULL DEFAULT '');
CREATE TABLE payroll_members(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),release_stage text NOT NULL,period_id text NOT NULL REFERENCES payroll_periods(id),employee_id text NOT NULL REFERENCES employees(id),UNIQUE(period_id,employee_id));
ALTER TABLE payroll ADD COLUMN release_stage text NOT NULL DEFAULT 'production' CHECK(release_stage IN('preview','production'));
ALTER TABLE payroll ADD COLUMN workflow_version integer NOT NULL DEFAULT 0;
ALTER TABLE payroll ADD COLUMN period_id text REFERENCES payroll_periods(id);
ALTER TABLE payroll ADD COLUMN minor_unit integer NOT NULL DEFAULT 2;
ALTER TABLE payroll ADD COLUMN regular_seconds integer NOT NULL DEFAULT 0;
ALTER TABLE payroll ADD COLUMN overtime_seconds integer NOT NULL DEFAULT 0;
ALTER TABLE payroll ADD COLUMN paid_break_seconds integer NOT NULL DEFAULT 0;
ALTER TABLE payroll ADD COLUMN unpaid_break_seconds integer NOT NULL DEFAULT 0;
ALTER TABLE payroll ADD COLUMN leave_seconds integer NOT NULL DEFAULT 0;
ALTER TABLE payroll ADD COLUMN holiday_seconds integer NOT NULL DEFAULT 0;
ALTER TABLE payroll ADD COLUMN deductions_minor integer NOT NULL DEFAULT 0;
ALTER TABLE payroll ADD COLUMN net_minor integer NOT NULL DEFAULT 0;
ALTER TABLE payroll ADD COLUMN employer_minor integer NOT NULL DEFAULT 0;
ALTER TABLE payroll ADD COLUMN approved_minor integer;
ALTER TABLE payroll ADD COLUMN source_hash text NOT NULL DEFAULT '';
ALTER TABLE payroll ADD COLUMN calculation_hash text NOT NULL DEFAULT '';
ALTER TABLE payroll ADD COLUMN approved_by text REFERENCES employees(id);
ALTER TABLE payroll ADD COLUMN approved_at text;
ALTER TABLE payroll ADD COLUMN review_note text NOT NULL DEFAULT '';
ALTER TABLE payroll ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE payroll ADD COLUMN updated_at text;
CREATE UNIQUE INDEX payroll_period_employee ON payroll(period_id,employee_id) WHERE period_id IS NOT NULL;
CREATE INDEX payroll_stage_employee_date ON payroll(release_stage,employee_id,ends_on);
CREATE TABLE payroll_settings(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),release_stage text NOT NULL,settings text NOT NULL,revision integer NOT NULL DEFAULT 1,updated_by text NOT NULL REFERENCES employees(id),updated_at text NOT NULL,UNIQUE(org_id,release_stage));
CREATE TABLE payroll_permissions(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),release_stage text NOT NULL,employee_id text NOT NULL REFERENCES employees(id),organization_access integer NOT NULL DEFAULT 0,updated_by text NOT NULL REFERENCES employees(id),updated_at text NOT NULL,UNIQUE(employee_id,release_stage));
CREATE TABLE payroll_profiles(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),release_stage text NOT NULL,employee_id text NOT NULL REFERENCES employees(id),effective_on text NOT NULL,settings text NOT NULL,created_by text NOT NULL REFERENCES employees(id),created_at text NOT NULL,note text NOT NULL);
CREATE INDEX payroll_profile_effective ON payroll_profiles(release_stage,employee_id,effective_on,created_at);
CREATE TABLE payroll_openings(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),release_stage text NOT NULL,employee_id text NOT NULL REFERENCES employees(id),tax_year integer NOT NULL,as_of text NOT NULL,balances text NOT NULL,status text NOT NULL DEFAULT 'Pending' CHECK(status IN('Pending','Approved','Rejected')),created_by text NOT NULL REFERENCES employees(id),approved_by text REFERENCES employees(id),created_at text NOT NULL,reviewed_at text,reference text NOT NULL,review_note text NOT NULL DEFAULT '',revision integer NOT NULL DEFAULT 1);
CREATE INDEX payroll_opening_employee_year ON payroll_openings(release_stage,employee_id,tax_year,created_at);
CREATE TABLE payroll_earnings(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),release_stage text NOT NULL,employee_id text NOT NULL REFERENCES employees(id),period_id text NOT NULL REFERENCES payroll_periods(id),kind text NOT NULL,label text NOT NULL,amount_minor integer NOT NULL,currency text NOT NULL,minor_unit integer NOT NULL,work_date text NOT NULL,seconds integer NOT NULL DEFAULT 0,non_periodic integer NOT NULL DEFAULT 0,taxable integer NOT NULL DEFAULT 1,pensionable integer NOT NULL DEFAULT 1,insurable integer NOT NULL DEFAULT 1,vacationable integer NOT NULL DEFAULT 0,pretax integer NOT NULL DEFAULT 0,related_id text,detail text NOT NULL DEFAULT '{}',status text NOT NULL DEFAULT 'Pending' CHECK(status IN('Pending','Approved','Rejected')),created_by text NOT NULL REFERENCES employees(id),approved_by text REFERENCES employees(id),created_at text NOT NULL,reviewed_at text,review_note text NOT NULL DEFAULT '',revision integer NOT NULL DEFAULT 1);
CREATE INDEX payroll_earnings_period_employee ON payroll_earnings(release_stage,period_id,employee_id,status);
CREATE TABLE payroll_sources(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),release_stage text NOT NULL,period_id text NOT NULL REFERENCES payroll_periods(id),payroll_id text NOT NULL REFERENCES payroll(id),employee_id text NOT NULL REFERENCES employees(id),source_type text NOT NULL,source_id text NOT NULL,source_revision integer NOT NULL,work_date text NOT NULL,snapshot text NOT NULL,finalized integer NOT NULL DEFAULT 0);
CREATE INDEX payroll_source_timesheet ON payroll_sources(release_stage,source_type,source_id,finalized);
CREATE UNIQUE INDEX payroll_finalized_source_day ON payroll_sources(release_stage,employee_id,source_type,source_id,work_date) WHERE finalized=1 AND source_type<>'Context';
CREATE TABLE payroll_reconciliations(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),release_stage text NOT NULL,payroll_id text NOT NULL REFERENCES payroll(id),employee_id text NOT NULL REFERENCES employees(id),timesheet_id text NOT NULL REFERENCES timesheets(id),source_revision integer NOT NULL,detail text NOT NULL,status text NOT NULL DEFAULT 'Pending' CHECK(status IN('Pending','Resolved')),resolved_by_item text REFERENCES payroll_earnings(id),created_at text NOT NULL,resolved_at text,UNIQUE(payroll_id,timesheet_id,source_revision));
CREATE TABLE payroll_payments(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),release_stage text NOT NULL,payroll_id text NOT NULL REFERENCES payroll(id),employee_id text NOT NULL REFERENCES employees(id),amount_minor integer NOT NULL CHECK(amount_minor<>0),currency text NOT NULL,paid_on text NOT NULL,method text NOT NULL,reference text NOT NULL,note text NOT NULL,reversal_of text UNIQUE REFERENCES payroll_payments(id),created_by text NOT NULL REFERENCES employees(id),created_at text NOT NULL,UNIQUE(release_stage,payroll_id,reference));
CREATE TABLE payroll_events(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),release_stage text NOT NULL,employee_id text REFERENCES employees(id),actor_id text NOT NULL REFERENCES employees(id),entity text NOT NULL,target_id text NOT NULL,action text NOT NULL,detail text NOT NULL DEFAULT '',created_at text NOT NULL);
CREATE INDEX payroll_events_scope ON payroll_events(release_stage,employee_id,created_at);
-- Runtime callers cannot rewrite finalized money, statements, rate history or audits.
-- Replace the legacy all-row guard with a guard that still freezes every legacy row.
DROP TRIGGER walshken_payroll_immutable ON public.payroll;
CREATE OR REPLACE FUNCTION public.protect_final_payroll() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $protect_payroll$
BEGIN
 IF TG_OP='DELETE' OR OLD.workflow_version<>1 OR OLD.status='Finalized' THEN RAISE EXCEPTION 'Finalized and legacy payroll is immutable; record an auditable adjustment';END IF;
 IF (OLD.id,OLD.org_id,OLD.employee_id,OLD.release_stage,OLD.workflow_version,OLD.period_id) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.employee_id,NEW.release_stage,NEW.workflow_version,NEW.period_id) THEN RAISE EXCEPTION 'Payroll identity is immutable';END IF;
 RETURN NEW;
END;
$protect_payroll$;
REVOKE ALL ON FUNCTION public.protect_final_payroll() FROM PUBLIC;
CREATE TRIGGER payroll_immutable_final BEFORE UPDATE OR DELETE ON payroll FOR EACH ROW EXECUTE FUNCTION public.protect_final_payroll();
CREATE OR REPLACE FUNCTION public.protect_final_pay_period() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $protect_period$
BEGIN
 IF OLD.status='Finalized' THEN RAISE EXCEPTION 'Finalized pay periods are immutable';END IF;RETURN NEW;
END;
$protect_period$;
REVOKE ALL ON FUNCTION public.protect_final_pay_period() FROM PUBLIC;
CREATE TRIGGER period_immutable_final BEFORE UPDATE OR DELETE ON payroll_periods FOR EACH ROW EXECUTE FUNCTION public.protect_final_pay_period();
DO $payroll_guards$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['payroll_members','payroll_periods','payroll_settings','payroll_permissions','payroll_profiles','payroll_openings','payroll_earnings','payroll_sources','payroll_reconciliations','payroll_payments','payroll_events'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON public.%I FROM anon',t);END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON public.%I FROM authenticated',t);END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='walshken_production_app') THEN
  CREATE POLICY compensation_preview_isolation ON compensation AS RESTRICTIVE TO walshken_production_app USING(release_stage='production') WITH CHECK(release_stage='production');
  CREATE POLICY payroll_preview_isolation ON payroll AS RESTRICTIVE TO walshken_production_app USING(release_stage='production') WITH CHECK(release_stage='production');
 END IF;
END;
$payroll_guards$;

CREATE OR REPLACE FUNCTION public.protect_payroll_sources() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $source_guard$
BEGIN
 IF OLD.finalized=1 OR EXISTS(SELECT 1 FROM public.payroll_periods p WHERE p.id=OLD.period_id AND p.status='Finalized') THEN RAISE EXCEPTION 'Finalized payroll source snapshots are immutable';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;
$source_guard$;
REVOKE ALL ON FUNCTION public.protect_payroll_sources() FROM PUBLIC;
CREATE TRIGGER payroll_sources_final BEFORE UPDATE OR DELETE ON payroll_sources FOR EACH ROW EXECUTE FUNCTION public.protect_payroll_sources();
CREATE OR REPLACE FUNCTION public.protect_approved_payroll_input() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $input_guard$
BEGIN
 IF OLD.status='Approved' THEN RAISE EXCEPTION 'Approved payroll input is immutable; append a correction entry';END IF;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;
$input_guard$;
REVOKE ALL ON FUNCTION public.protect_approved_payroll_input() FROM PUBLIC;
CREATE TRIGGER earnings_approved_immutable BEFORE UPDATE OR DELETE ON payroll_earnings FOR EACH ROW EXECUTE FUNCTION public.protect_approved_payroll_input();
CREATE TRIGGER opening_approved_immutable BEFORE UPDATE OR DELETE ON payroll_openings FOR EACH ROW EXECUTE FUNCTION public.protect_approved_payroll_input();

-- Rates stay immutable; only a one-way void marker is allowed for a new workflow rate.
DROP TRIGGER walshken_compensation_immutable ON public.compensation;
CREATE OR REPLACE FUNCTION public.protect_salary_history() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $salary_guard$
BEGIN
 IF TG_OP='DELETE' OR OLD.workflow_version<>1 OR OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL OR (to_jsonb(OLD)-'voided_at') IS DISTINCT FROM (to_jsonb(NEW)-'voided_at') THEN RAISE EXCEPTION 'Salary history is immutable; append a new effective rate';END IF;
 RETURN NEW;
END;
$salary_guard$;
REVOKE ALL ON FUNCTION public.protect_salary_history() FROM PUBLIC;
CREATE TRIGGER salary_history_immutable BEFORE UPDATE OR DELETE ON public.compensation FOR EACH ROW EXECUTE FUNCTION public.protect_salary_history();

CREATE TRIGGER payroll_events_immutable BEFORE UPDATE OR DELETE ON payroll_events FOR EACH ROW EXECUTE FUNCTION public.walshken_reject_history_mutation();
CREATE TRIGGER payroll_payments_immutable BEFORE UPDATE OR DELETE ON payroll_payments FOR EACH ROW EXECUTE FUNCTION public.walshken_reject_history_mutation();
CREATE TRIGGER payroll_profiles_immutable BEFORE UPDATE OR DELETE ON payroll_profiles FOR EACH ROW EXECUTE FUNCTION public.walshken_reject_history_mutation();
CREATE TRIGGER payroll_members_immutable BEFORE UPDATE OR DELETE ON payroll_members FOR EACH ROW EXECUTE FUNCTION public.walshken_reject_history_mutation();
CREATE INDEX payroll_periods_stage_dates ON payroll_periods(org_id,release_stage,starts_on);
CREATE INDEX payroll_members_employee ON payroll_members(employee_id,release_stage,period_id);
CREATE INDEX payroll_sources_row ON payroll_sources(payroll_id);
CREATE INDEX payroll_sources_period ON payroll_sources(period_id);
CREATE INDEX payroll_payments_row_date ON payroll_payments(payroll_id,created_at);
CREATE INDEX payroll_events_scope_date ON payroll_events(org_id,release_stage,created_at);
CREATE INDEX payroll_reconciliation_employee ON payroll_reconciliations(employee_id,release_stage,status);
