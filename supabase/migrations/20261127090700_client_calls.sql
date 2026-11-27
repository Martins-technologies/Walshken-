CREATE TABLE client_call_endpoints (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
  kind text NOT NULL CHECK (kind IN ('Office','Support')),
  employee_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  FOREIGN KEY (org_id,employee_id) REFERENCES employees(org_id,id),
  UNIQUE (org_id,id)
);
CREATE UNIQUE INDEX client_call_endpoint_name ON client_call_endpoints(org_id,lower(name));
CREATE INDEX client_call_endpoint_staff ON client_call_endpoints(org_id,employee_id) WHERE enabled;

CREATE TABLE client_calls (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  case_id text,
  employee_id text,
  endpoint_id text,
  company_name text NOT NULL CHECK (length(company_name) BETWEEN 2 AND 100),
  client_name text NOT NULL CHECK (length(client_name) BETWEEN 1 AND 140),
  initiator text NOT NULL CHECK (initiator IN ('client','staff')),
  mode text NOT NULL CHECK (mode IN ('Audio','Video')),
  status text NOT NULL CHECK (status IN ('Ringing','Accepted','Connected','Busy','Unavailable','Missed','Declined','Ended','Cancelled')),
  provider_room text NOT NULL UNIQUE CHECK (provider_room='wk-client-' || id),
  created_at text NOT NULL,
  ring_expires_at text NOT NULL,
  accepted_at text,
  connect_expires_at text,
  hard_expires_at text,
  room_created_at text,
  room_sid text,
  room_closed_at text,
  client_session_ref text,
  staff_session_id text,
  client_sid text,
  staff_sid text,
  client_signal_at text,
  staff_signal_at text,
  connected_at text,
  reconnect_expires_at text,
  checked_at text,
  ended_at text,
  UNIQUE (org_id,id),
  FOREIGN KEY (org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY (case_id,customer_id) REFERENCES client_cases(id,customer_id),
  FOREIGN KEY (org_id,employee_id) REFERENCES employees(org_id,id),
  FOREIGN KEY (org_id,endpoint_id) REFERENCES client_call_endpoints(org_id,id),
  CHECK (case_id IS NOT NULL OR endpoint_id IS NOT NULL),
  CHECK (initiator <> 'staff' OR (case_id IS NOT NULL AND endpoint_id IS NULL)),
  CHECK (status NOT IN ('Ringing','Accepted','Connected') OR employee_id IS NOT NULL),
  CHECK (status NOT IN ('Accepted','Connected') OR (accepted_at IS NOT NULL AND connect_expires_at IS NOT NULL AND hard_expires_at IS NOT NULL)),
  CHECK (status <> 'Connected' OR connected_at IS NOT NULL),
  CHECK ((ended_at IS NULL) = (status IN ('Ringing','Accepted','Connected')))
);
CREATE UNIQUE INDEX client_call_active_customer ON client_calls(customer_id) WHERE status IN ('Ringing','Accepted','Connected');
CREATE UNIQUE INDEX client_call_active_staff ON client_calls(org_id,employee_id) WHERE status IN ('Ringing','Accepted','Connected');
CREATE INDEX client_call_customer_history ON client_calls(customer_id,created_at DESC,id);
CREATE INDEX client_call_staff_history ON client_calls(org_id,employee_id,created_at DESC,id);
CREATE INDEX client_call_case_history ON client_calls(org_id,case_id,created_at DESC,id);
CREATE INDEX client_call_maintenance ON client_calls(status,ring_expires_at,hard_expires_at,room_closed_at);

CREATE TABLE client_call_provider_events (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  call_id text NOT NULL,
  event_type text NOT NULL,
  received_at text NOT NULL,
  FOREIGN KEY (org_id,call_id) REFERENCES client_calls(org_id,id)
);
CREATE INDEX client_call_provider_events_call ON client_call_provider_events(org_id,call_id);

ALTER TABLE client_call_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_call_provider_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE client_call_endpoints, client_calls, client_call_provider_events FROM PUBLIC;
