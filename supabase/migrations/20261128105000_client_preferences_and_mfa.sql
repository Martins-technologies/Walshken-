CREATE TABLE client_portal_language_policy (
  org_id text PRIMARY KEY REFERENCES organizations(id),
  enabled text[] NOT NULL DEFAULT ARRAY['en','fr','ur','hi']::text[],
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (enabled @> ARRAY['en']::text[] AND enabled <@ ARRAY['en','fr','ur','hi']::text[])
);
CREATE TABLE client_portal_preferences (
  customer_id text PRIMARY KEY REFERENCES customers(id),
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','fr','ur','hi')),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE client_mfa (
  customer_id text PRIMARY KEY REFERENCES customers(id),
  secret text,
  pending_secret text,
  pending_expires_at timestamptz,
  confirmed_at timestamptz,
  last_step integer NOT NULL DEFAULT -1,
  CHECK (confirmed_at IS NULL OR secret IS NOT NULL),
  CHECK ((pending_secret IS NULL) = (pending_expires_at IS NULL))
);
CREATE TABLE client_mfa_recovery (
  customer_id text NOT NULL REFERENCES client_mfa(customer_id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  PRIMARY KEY (customer_id,code_hash)
);
ALTER TABLE client_portal_language_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_portal_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_mfa ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_mfa_recovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON client_portal_language_policy,client_portal_preferences,client_mfa,client_mfa_recovery FROM PUBLIC;
ALTER TABLE client_notifications DROP CONSTRAINT client_notifications_type_check;
ALTER TABLE client_notifications ADD CONSTRAINT client_notifications_type_check
  CHECK (type IN ('security','case','document','payment','invoice','agreement','call','announcement','appointment','payment-reminder','meeting-reminder'));
ALTER TABLE client_notifications ADD COLUMN provider_delivery text CHECK (provider_delivery IN ('Delivered','Delayed','Bounced','Complained','Failed'));
ALTER TABLE client_notifications ADD COLUMN provider_delivered_at timestamptz;
CREATE INDEX client_notifications_receipt_idx ON client_notifications(provider_receipt) WHERE provider_receipt IS NOT NULL;

CREATE TABLE client_account_access_history (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  employee_id text NOT NULL REFERENCES employees(id),
  action text NOT NULL CHECK (action IN ('Suspended','Restored')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX client_account_access_history_idx ON client_account_access_history(customer_id,created_at DESC);
ALTER TABLE client_account_access_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON client_account_access_history FROM PUBLIC;
