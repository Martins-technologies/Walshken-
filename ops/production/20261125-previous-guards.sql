-- Reference snapshot only; app rollback should preserve additive schema and these stronger guards.
CREATE OR REPLACE FUNCTION public.protect_final_payroll()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 IF TG_OP='DELETE' OR OLD.workflow_version<>1 OR OLD.status='Finalized' THEN RAISE EXCEPTION 'Finalized and legacy payroll is immutable; record an auditable adjustment';END IF;
 IF (OLD.id,OLD.org_id,OLD.employee_id,OLD.release_stage,OLD.workflow_version,OLD.period_id) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.employee_id,NEW.release_stage,NEW.workflow_version,NEW.period_id) THEN RAISE EXCEPTION 'Payroll identity is immutable';END IF;
 RETURN NEW;
END;
$function$

CREATE OR REPLACE FUNCTION public.walshken_reject_history_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Walshken history rows are immutable';
END;
$function$

CREATE OR REPLACE FUNCTION public.protect_payroll_sources()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 IF OLD.finalized=1 OR EXISTS(SELECT 1 FROM public.payroll_periods p WHERE p.id=OLD.period_id AND p.status='Finalized') THEN RAISE EXCEPTION 'Finalized payroll source snapshots are immutable';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;
$function$

CREATE OR REPLACE FUNCTION public.protect_approved_payroll_input()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 IF OLD.status='Approved' THEN RAISE EXCEPTION 'Approved payroll input is immutable; append a correction entry';END IF;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;
$function$

CREATE OR REPLACE FUNCTION public.protect_final_pay_period()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 IF OLD.status='Finalized' THEN RAISE EXCEPTION 'Finalized pay periods are immutable';END IF;RETURN NEW;
END;
$function$

CREATE OR REPLACE FUNCTION public.protect_salary_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 IF TG_OP='DELETE' OR OLD.workflow_version<>1 OR OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL OR (to_jsonb(OLD)-'voided_at') IS DISTINCT FROM (to_jsonb(NEW)-'voided_at') THEN RAISE EXCEPTION 'Salary history is immutable; append a new effective rate';END IF;
 RETURN NEW;
END;
$function$

