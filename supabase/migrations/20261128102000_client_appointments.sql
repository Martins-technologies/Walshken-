CREATE TABLE client_appointment_slots (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  employee_id text NOT NULL,
  published_by text NOT NULL,
  starts_at text NOT NULL,
  ends_at text NOT NULL,
  time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 70),
  mode text NOT NULL CHECK (mode IN ('Audio','Video')),
  published boolean NOT NULL DEFAULT true,
  occupied boolean NOT NULL DEFAULT false,
  created_at text NOT NULL,
  UNIQUE (org_id,id,employee_id),
  FOREIGN KEY (org_id,employee_id) REFERENCES employees(org_id,id),
  FOREIGN KEY (org_id,published_by) REFERENCES employees(org_id,id),
  CHECK (ends_at::timestamptz - starts_at::timestamptz BETWEEN INTERVAL '15 minutes' AND INTERVAL '120 minutes'),
  CHECK (published OR NOT occupied)
);

CREATE INDEX client_appointment_host_availability
  ON client_appointment_slots(org_id,employee_id,starts_at,ends_at)
  WHERE published;

CREATE TABLE client_appointments (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  case_id text NOT NULL,
  customer_id text NOT NULL REFERENCES customers(id),
  employee_id text NOT NULL,
  slot_id text NOT NULL,
  representative_name text NOT NULL CHECK (length(representative_name) BETWEEN 2 AND 100),
  starts_at text NOT NULL,
  ends_at text NOT NULL,
  time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 70),
  mode text NOT NULL CHECK (mode IN ('Audio','Video')),
  status text NOT NULL DEFAULT 'Booked' CHECK (status IN ('Booked','Cancelled','Completed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (org_id,id,customer_id),
  FOREIGN KEY (org_id,case_id) REFERENCES client_cases(org_id,id),
  FOREIGN KEY (case_id,customer_id) REFERENCES client_cases(id,customer_id),
  FOREIGN KEY (org_id,slot_id,employee_id) REFERENCES client_appointment_slots(org_id,id,employee_id),
  CHECK (ends_at::timestamptz > starts_at::timestamptz)
);
CREATE UNIQUE INDEX client_appointment_single_booking ON client_appointments(slot_id) WHERE status='Booked';
CREATE INDEX client_appointment_customer_history ON client_appointments(customer_id,starts_at DESC,id);
CREATE INDEX client_appointment_case_history ON client_appointments(org_id,case_id,starts_at DESC,id);
CREATE INDEX client_appointment_reminders ON client_appointments(org_id,starts_at,id) WHERE status='Booked';

CREATE TABLE client_appointment_events (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  appointment_id text NOT NULL,
  customer_id text NOT NULL REFERENCES customers(id),
  staff_actor_id text,
  event text NOT NULL CHECK (event IN ('Booked','Rescheduled','Cancelled','Completed','Join opened','Reminder 24h','Reminder 1h')),
  reference text,
  created_at text NOT NULL,
  FOREIGN KEY (org_id,appointment_id,customer_id) REFERENCES client_appointments(org_id,id,customer_id),
  FOREIGN KEY (org_id,staff_actor_id) REFERENCES employees(org_id,id),
  CHECK ((event IN ('Reminder 24h','Reminder 1h')) = (reference IS NOT NULL))
);
CREATE UNIQUE INDEX client_appointment_reminder_once
  ON client_appointment_events(appointment_id,event,reference) WHERE reference IS NOT NULL;
CREATE INDEX client_appointment_event_history
  ON client_appointment_events(org_id,appointment_id,created_at DESC,id);

ALTER TABLE client_appointment_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_appointment_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON client_appointment_slots,client_appointments,client_appointment_events FROM PUBLIC;

-- A client transaction may see schedules for its active representative. A customer
-- can also release a prior reservation after the case has been reassigned.
CREATE POLICY client_appointment_slot_customer_scope ON client_appointment_slots AS RESTRICTIVE
  USING (
    NULLIF(current_setting('walshken.client_customer_id', true),'') IS NULL
    OR EXISTS (SELECT 1 FROM client_cases c
      WHERE c.org_id=client_appointment_slots.org_id AND c.assigned_employee_id=client_appointment_slots.employee_id
        AND c.customer_id=NULLIF(current_setting('walshken.client_customer_id', true),''))
    OR EXISTS (SELECT 1 FROM client_appointments a
      WHERE a.slot_id=client_appointment_slots.id AND a.org_id=client_appointment_slots.org_id
        AND a.customer_id=NULLIF(current_setting('walshken.client_customer_id', true),''))
  );

CREATE POLICY client_appointment_customer_scope ON client_appointments AS RESTRICTIVE
  USING (NULLIF(current_setting('walshken.client_customer_id',true),'') IS NULL
    OR customer_id=NULLIF(current_setting('walshken.client_customer_id',true),''));

CREATE POLICY client_appointment_event_customer_scope ON client_appointment_events AS RESTRICTIVE
  USING (NULLIF(current_setting('walshken.client_customer_id',true),'') IS NULL
    OR customer_id=NULLIF(current_setting('walshken.client_customer_id',true),''));
