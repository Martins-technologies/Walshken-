-- Preserve each existing invoice and payment while letting multiple settled
-- payments apply to one invoice. Currency still belongs to the invoice.
ALTER TABLE client_invoices ADD UNIQUE (org_id,id,currency), ADD UNIQUE (org_id,id,customer_id);
ALTER TABLE client_payments
  DROP CONSTRAINT client_payments_org_id_invoice_id_currency_amount_minor_fkey,
  ADD CONSTRAINT client_payments_invoice_currency_fk
    FOREIGN KEY (org_id,invoice_id,currency) REFERENCES client_invoices(org_id,id,currency),
  DROP CONSTRAINT client_payments_status_check,
  ADD CONSTRAINT client_payments_status_check
    CHECK (status IN ('Creating','Pending','Processing','Paid','Failed','Expired','Review','Refunded'));
DROP INDEX client_payments_active_invoice;
CREATE UNIQUE INDEX client_payments_active_invoice ON client_payments(invoice_id)
  WHERE status IN ('Creating','Pending','Processing');
CREATE INDEX client_payments_invoice_paid ON client_payments(org_id,invoice_id) WHERE status='Paid';

CREATE TABLE client_payment_plans (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  invoice_id text NOT NULL,
  customer_id text NOT NULL REFERENCES customers(id),
  mode text NOT NULL CHECK (mode IN ('Partial','Installments')),
  created_by text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL,
  retired_at text,
  UNIQUE (org_id,id,invoice_id,customer_id),
  FOREIGN KEY (org_id,invoice_id,customer_id) REFERENCES client_invoices(org_id,id,customer_id)
);
CREATE UNIQUE INDEX client_payment_plans_one_active ON client_payment_plans(invoice_id) WHERE retired_at IS NULL;

CREATE TABLE client_payment_installments (
  id text PRIMARY KEY,
  plan_id text NOT NULL,
  org_id text NOT NULL,
  invoice_id text NOT NULL,
  customer_id text NOT NULL REFERENCES customers(id),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 24),
  due_on text NOT NULL CHECK (due_on ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  amount_minor integer NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 99999999),
  UNIQUE (plan_id,position),
  UNIQUE (plan_id,due_on),
  FOREIGN KEY (org_id,plan_id,invoice_id,customer_id) REFERENCES client_payment_plans(org_id,id,invoice_id,customer_id)
);

CREATE FUNCTION protect_client_payment_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='client_payment_plans' THEN
    IF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL
      AND (to_jsonb(NEW)-'retired_at')=(to_jsonb(OLD)-'retired_at') THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Client payment schedules are immutable';
END;
$$;

CREATE TRIGGER client_payment_plans_retirement BEFORE UPDATE OR DELETE ON client_payment_plans
  FOR EACH ROW EXECUTE FUNCTION protect_client_payment_plan();
CREATE TRIGGER client_payment_installments_evidence BEFORE UPDATE OR DELETE ON client_payment_installments
  FOR EACH ROW EXECUTE FUNCTION protect_client_payment_plan();

CREATE FUNCTION enforce_client_payment_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invoice_total integer; previous_amount bigint;
BEGIN
  SELECT total_minor INTO invoice_total FROM client_invoices
    WHERE id=NEW.invoice_id AND org_id=NEW.org_id FOR UPDATE;
  IF invoice_total IS NULL OR NEW.amount_minor>invoice_total THEN
    RAISE EXCEPTION 'Payment cannot exceed the invoice total';
  END IF;
  IF NEW.status='Paid' THEN
    SELECT COALESCE(SUM(amount_minor),0) INTO previous_amount FROM client_payments
      WHERE invoice_id=NEW.invoice_id AND org_id=NEW.org_id AND id<>NEW.id AND status='Paid';
    IF previous_amount+NEW.amount_minor>invoice_total THEN
      RAISE EXCEPTION 'Verified payments cannot exceed the invoice balance';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER client_payments_balance BEFORE INSERT OR UPDATE ON client_payments
  FOR EACH ROW EXECUTE FUNCTION enforce_client_payment_balance();

DO $client_plan_rls$
DECLARE name text; web_role text;
BEGIN
  FOREACH name IN ARRAY ARRAY['client_payment_plans','client_payment_installments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',name);
    FOREACH web_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=web_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I',name,web_role);
      END IF;
    END LOOP;
  END LOOP;
END;
$client_plan_rls$;
