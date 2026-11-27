CREATE TABLE client_invoice_sequences (
  org_id text NOT NULL REFERENCES organizations(id),
  issue_year integer NOT NULL,
  last_number integer NOT NULL CHECK (last_number > 0),
  PRIMARY KEY (org_id, issue_year)
);

CREATE TABLE client_invoices (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  case_id text NOT NULL,
  customer_id text NOT NULL REFERENCES customers(id),
  invoice_number text UNIQUE,
  issuer_name text NOT NULL,
  issuer_address text NOT NULL,
  issuer_tax_number text NOT NULL DEFAULT '',
  recipient_name text NOT NULL,
  recipient_email text NOT NULL,
  currency text NOT NULL CHECK (currency IN ('CAD','USD','INR','PKR','GBP','EUR')),
  issue_on text,
  due_on text NOT NULL,
  subtotal_minor integer NOT NULL CHECK (subtotal_minor > 0),
  tax_minor integer NOT NULL CHECK (tax_minor >= 0),
  total_minor integer NOT NULL CHECK (total_minor = subtotal_minor + tax_minor AND total_minor <= 99999999),
  status text NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Open','Processing','Paid','Void')),
  created_by text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  void_reason text,
  UNIQUE (org_id, id),
  UNIQUE (org_id, id, currency, total_minor),
  FOREIGN KEY (org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY (case_id,customer_id) REFERENCES client_cases(id,customer_id),
  CHECK ((status='Draft' AND invoice_number IS NULL AND issue_on IS NULL) OR (status<>'Draft' AND invoice_number IS NOT NULL AND issue_on IS NOT NULL)),
  CHECK ((status='Void') = (void_reason IS NOT NULL))
);
CREATE INDEX client_invoices_account_idx ON client_invoices(customer_id,status,created_at DESC);
CREATE INDEX client_invoices_case_idx ON client_invoices(org_id,case_id,created_at DESC);

CREATE TABLE client_invoice_items (
  org_id text NOT NULL,
  invoice_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 1),
  description text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_minor integer NOT NULL CHECK (unit_minor >= 0),
  tax_bps integer NOT NULL CHECK (tax_bps BETWEEN 0 AND 10000),
  subtotal_minor integer NOT NULL CHECK (subtotal_minor = quantity::bigint * unit_minor),
  tax_minor integer NOT NULL CHECK (tax_minor = (subtotal_minor::bigint * tax_bps + 5000) / 10000),
  total_minor integer NOT NULL CHECK (total_minor = subtotal_minor + tax_minor),
  PRIMARY KEY (invoice_id,position),
  FOREIGN KEY (org_id,invoice_id) REFERENCES client_invoices(org_id,id)
);

CREATE TABLE client_payments (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  invoice_id text NOT NULL,
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  provider text NOT NULL CHECK (provider = 'stripe'),
  sandbox boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('Creating','Pending','Processing','Paid','Failed','Expired')),
  provider_session text UNIQUE,
  provider_reference text UNIQUE,
  checkout_url text,
  expiry_at text,
  confirmed_at text,
  receipt_number text UNIQUE,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  FOREIGN KEY (org_id,invoice_id,currency,amount_minor) REFERENCES client_invoices(org_id,id,currency,total_minor),
  CHECK ((status='Paid') = (confirmed_at IS NOT NULL AND receipt_number IS NOT NULL))
);
CREATE UNIQUE INDEX client_payments_active_invoice ON client_payments(invoice_id)
  WHERE status IN ('Creating','Pending','Processing','Paid');
CREATE INDEX client_payments_invoice_record ON client_payments(invoice_id,created_at DESC);

CREATE TABLE client_payment_events (
  org_id text NOT NULL REFERENCES organizations(id),
  provider text NOT NULL CHECK (provider = 'stripe'),
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  payment_id text NOT NULL REFERENCES client_payments(id),
  received_at text NOT NULL,
  PRIMARY KEY (provider,event_id)
);

CREATE TABLE client_agreements (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  case_id text NOT NULL,
  customer_id text NOT NULL REFERENCES customers(id),
  created_by text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL,
  UNIQUE (org_id,id),
  FOREIGN KEY (org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY (case_id,customer_id) REFERENCES client_cases(id,customer_id)
);
CREATE INDEX client_agreements_account_idx ON client_agreements(customer_id,created_at DESC);
CREATE INDEX client_agreements_case_idx ON client_agreements(org_id,case_id,created_at DESC);

CREATE TABLE client_agreement_versions (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  agreement_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  issuer_name text NOT NULL,
  terms text NOT NULL,
  undertakings text NOT NULL DEFAULT '',
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL,
  published_by text REFERENCES employees(id),
  published_at text,
  withdrawn_by text REFERENCES employees(id),
  withdrawn_at text,
  withdrawal_reason text,
  UNIQUE (agreement_id,version),
  UNIQUE (org_id,id,content_hash),
  FOREIGN KEY (org_id,agreement_id) REFERENCES client_agreements(org_id,id),
  CHECK ((published_by IS NULL) = (published_at IS NULL)),
  CHECK ((withdrawn_by IS NULL) = (withdrawn_at IS NULL) AND (withdrawn_at IS NULL) = (withdrawal_reason IS NULL)),
  CHECK (withdrawn_at IS NULL OR published_at IS NOT NULL)
);

CREATE TABLE client_agreement_responses (
  version_id text PRIMARY KEY,
  org_id text NOT NULL,
  customer_id text NOT NULL REFERENCES customers(id),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  decision text NOT NULL CHECK (decision IN ('Signed','Declined')),
  signer_name text NOT NULL,
  signer_email text NOT NULL,
  session_hash text NOT NULL CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  consent_version text NOT NULL,
  consent boolean NOT NULL,
  reason text,
  responded_at text NOT NULL,
  signed_pdf bytea,
  signed_pdf_hash text CHECK (signed_pdf_hash IS NULL OR signed_pdf_hash ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY (org_id,version_id,content_hash) REFERENCES client_agreement_versions(org_id,id,content_hash),
  CHECK ((decision='Signed') = consent),
  CHECK ((decision='Signed') = (signed_pdf IS NOT NULL AND signed_pdf_hash IS NOT NULL))
);

CREATE TABLE client_finance_activity (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  case_id text NOT NULL,
  customer_id text NOT NULL,
  employee_id text REFERENCES employees(id),
  action text NOT NULL,
  entity_id text NOT NULL,
  summary text NOT NULL,
  created_at text NOT NULL,
  FOREIGN KEY (org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY (case_id,customer_id) REFERENCES client_cases(id,customer_id)
);
CREATE INDEX client_finance_activity_case_idx ON client_finance_activity(org_id,case_id,created_at DESC);

CREATE FUNCTION protect_client_finance_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF EXISTS (SELECT 1 FROM client_invoices WHERE id=NEW.invoice_id AND status='Draft') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Issued invoice items are immutable';
  END IF;
  IF TG_OP='DELETE' THEN
    IF TG_TABLE_NAME='client_invoice_items' AND EXISTS (SELECT 1 FROM client_invoices WHERE id=OLD.invoice_id AND status='Draft') THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Client finance evidence is immutable';
  END IF;
  IF TG_TABLE_NAME='client_invoices' THEN
    IF OLD.status='Draft' OR (to_jsonb(NEW)-ARRAY['status','updated_at','void_reason']) =
       (to_jsonb(OLD)-ARRAY['status','updated_at','void_reason']) AND OLD.status NOT IN ('Paid','Void') THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='client_invoice_items' THEN
    IF EXISTS (SELECT 1 FROM client_invoices WHERE id=NEW.invoice_id AND status='Draft') THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='client_agreement_versions' THEN
    IF (to_jsonb(NEW)-ARRAY['published_at','published_by','withdrawn_at','withdrawn_by','withdrawal_reason']) =
       (to_jsonb(OLD)-ARRAY['published_at','published_by','withdrawn_at','withdrawn_by','withdrawal_reason'])
       AND (OLD.published_at IS NULL OR (NEW.published_at,NEW.published_by) IS NOT DISTINCT FROM (OLD.published_at,OLD.published_by))
       AND OLD.withdrawn_at IS NULL THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='client_payments' THEN
    IF OLD.status<>'Paid' AND (to_jsonb(NEW)-ARRAY['status','provider_session','provider_reference','checkout_url','expiry_at','confirmed_at','receipt_number','updated_at']) =
       (to_jsonb(OLD)-ARRAY['status','provider_session','provider_reference','checkout_url','expiry_at','confirmed_at','receipt_number','updated_at'])
       AND (OLD.provider_session IS NULL OR NEW.provider_session IS NOT DISTINCT FROM OLD.provider_session)
       AND (OLD.provider_reference IS NULL OR NEW.provider_reference IS NOT DISTINCT FROM OLD.provider_reference) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Client finance evidence is immutable';
END;
$$;

CREATE TRIGGER client_invoice_item_insert_guard BEFORE INSERT ON client_invoice_items
  FOR EACH ROW EXECUTE FUNCTION protect_client_finance_snapshot();

DO $client_finance_rls$
DECLARE name text; web_role text;
BEGIN
  FOREACH name IN ARRAY ARRAY['client_invoice_sequences','client_invoices','client_invoice_items',
    'client_payments','client_payment_events','client_agreements','client_agreement_versions',
    'client_agreement_responses','client_finance_activity'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',name);
    FOREACH web_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = web_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I',name,web_role);
      END IF;
    END LOOP;
    IF name<>'client_invoice_sequences' THEN
      EXECUTE format('CREATE TRIGGER client_finance_immutable BEFORE UPDATE OR DELETE ON %I
        FOR EACH ROW EXECUTE FUNCTION protect_client_finance_snapshot()',name);
    END IF;
  END LOOP;
END;
$client_finance_rls$;
