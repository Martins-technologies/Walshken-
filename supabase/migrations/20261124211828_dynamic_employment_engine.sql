CREATE TABLE employment_countries (
 org_id text NOT NULL REFERENCES organizations(id), code text NOT NULL CHECK(code IN ('CA','IN','PK')),
 name text NOT NULL, currency text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1, updated_by text REFERENCES employees(id), updated_at text NOT NULL,
 PRIMARY KEY(org_id,code)
);
CREATE TABLE employment_regions (
 org_id text NOT NULL, code text NOT NULL, country text NOT NULL, name text NOT NULL, kind text NOT NULL,
 enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
 updated_by text REFERENCES employees(id), updated_at text NOT NULL,
 PRIMARY KEY(org_id,code), FOREIGN KEY(org_id,country) REFERENCES employment_countries(org_id,code),
 CHECK(split_part(code,'-',1)=country)
);
ALTER TABLE staff_jurisdiction_versions ADD COLUMN category text NOT NULL DEFAULT 'Evidence'
 CHECK(category IN ('Work','Overtime','Holiday calendar','Leave','Canada Alberta payroll','Evidence'));
ALTER TABLE staff_jurisdiction_versions ADD COLUMN settings text;
ALTER TABLE staff_jurisdiction_versions ADD COLUMN settings_hash text;
ALTER TABLE staff_jurisdiction_versions ADD COLUMN mandatory boolean NOT NULL DEFAULT false;
ALTER TABLE staff_jurisdiction_versions ADD COLUMN predecessor_id text REFERENCES staff_jurisdiction_versions(id);
ALTER TABLE staff_jurisdiction_versions ADD CONSTRAINT policy_settings_integrity CHECK(
 (category='Evidence' AND settings IS NULL AND settings_hash IS NULL) OR
 (category<>'Evidence' AND settings IS NOT NULL AND settings_hash IS NOT NULL)
);
CREATE INDEX employment_policy_lookup ON staff_jurisdiction_versions(org_id,jurisdiction,classification,category,effective_from,effective_through);
CREATE TABLE staff_employment_terms (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), employee_id text NOT NULL REFERENCES employees(id),
 effective_on text NOT NULL, country text NOT NULL, region_code text NOT NULL, jurisdiction text NOT NULL,
 classification text NOT NULL, city text NOT NULL, office_id text REFERENCES units(id), time_zone text NOT NULL,
 employment_type text NOT NULL CHECK(employment_type IN ('Full-time','Part-time','Fixed-term','Contractor')),
 category text NOT NULL, compensation_type text NOT NULL CHECK(compensation_type IN ('Hourly','Salaried','Contract fee')),
 currency text NOT NULL, frequency text NOT NULL CHECK(frequency IN ('Weekly','Biweekly','Semimonthly','Monthly')),
 expected_hours integer NOT NULL CHECK(expected_hours BETWEEN 0 AND 80), schedule text NOT NULL,
 reference text NOT NULL, created_by text NOT NULL REFERENCES employees(id), created_at text NOT NULL,
 UNIQUE(employee_id,effective_on), FOREIGN KEY(org_id,country) REFERENCES employment_countries(org_id,code),
 FOREIGN KEY(org_id,region_code) REFERENCES employment_regions(org_id,code),
 FOREIGN KEY(org_id,jurisdiction) REFERENCES employment_regions(org_id,code),
 CHECK(split_part(region_code,'-',1)=country AND split_part(jurisdiction,'-',1)=country)
);
CREATE INDEX staff_terms_current ON staff_employment_terms(org_id,employee_id,effective_on DESC);
DO $migration$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['employment_countries','employment_regions','staff_employment_terms'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC,anon,authenticated',t);
 END LOOP;
END;
$migration$;
CREATE TRIGGER protect_staff_history BEFORE UPDATE OR DELETE ON staff_employment_terms
 FOR EACH ROW EXECUTE FUNCTION walshken_reject_history_mutation();

INSERT INTO employment_countries(org_id,code,name,currency,updated_at)
SELECT o.id,v.code,v.name,v.currency,to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM organizations o CROSS JOIN (VALUES ('CA','Canada','CAD'),('IN','India','INR'),('PK','Pakistan','PKR')) v(code,name,currency);
INSERT INTO employment_regions(org_id,code,country,name,kind,updated_at)
SELECT o.id,v.code,v.country,v.name,v.kind,to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM organizations o CROSS JOIN (VALUES
('CA-AB','CA','Alberta','Province'),
('CA-BC','CA','British Columbia','Province'),
('CA-MB','CA','Manitoba','Province'),
('CA-NB','CA','New Brunswick','Province'),
('CA-NL','CA','Newfoundland and Labrador','Province'),
('CA-NS','CA','Nova Scotia','Province'),
('CA-ON','CA','Ontario','Province'),
('CA-PE','CA','Prince Edward Island','Province'),
('CA-QC','CA','Quebec','Province'),
('CA-SK','CA','Saskatchewan','Province'),
('CA-NT','CA','Northwest Territories','Territory'),
('CA-NU','CA','Nunavut','Territory'),
('CA-YT','CA','Yukon','Territory'),
('CA-FED','CA','Federal employment jurisdiction','Federal'),
('IN-AP','IN','Andhra Pradesh','State'),
('IN-AR','IN','Arunachal Pradesh','State'),
('IN-AS','IN','Assam','State'),
('IN-BR','IN','Bihar','State'),
('IN-CT','IN','Chhattisgarh','State'),
('IN-GA','IN','Goa','State'),
('IN-GJ','IN','Gujarat','State'),
('IN-HR','IN','Haryana','State'),
('IN-HP','IN','Himachal Pradesh','State'),
('IN-JH','IN','Jharkhand','State'),
('IN-KA','IN','Karnataka','State'),
('IN-KL','IN','Kerala','State'),
('IN-MP','IN','Madhya Pradesh','State'),
('IN-MH','IN','Maharashtra','State'),
('IN-MN','IN','Manipur','State'),
('IN-ML','IN','Meghalaya','State'),
('IN-MZ','IN','Mizoram','State'),
('IN-NL','IN','Nagaland','State'),
('IN-OD','IN','Odisha','State'),
('IN-PB','IN','Punjab','State'),
('IN-RJ','IN','Rajasthan','State'),
('IN-SK','IN','Sikkim','State'),
('IN-TN','IN','Tamil Nadu','State'),
('IN-TS','IN','Telangana','State'),
('IN-TR','IN','Tripura','State'),
('IN-UP','IN','Uttar Pradesh','State'),
('IN-UK','IN','Uttarakhand','State'),
('IN-WB','IN','West Bengal','State'),
('IN-AN','IN','Andaman and Nicobar Islands','Union territory'),
('IN-CH','IN','Chandigarh','Union territory'),
('IN-DH','IN','Dadra and Nagar Haveli and Daman and Diu','Union territory'),
('IN-DL','IN','Delhi','Union territory'),
('IN-JK','IN','Jammu and Kashmir','Union territory'),
('IN-LA','IN','Ladakh','Union territory'),
('IN-LD','IN','Lakshadweep','Union territory'),
('IN-PY','IN','Puducherry','Union territory'),
('IN-CENTRAL','IN','Central employment jurisdiction','Federal'),
('PK-PB','PK','Punjab','Province'),
('PK-SD','PK','Sindh','Province'),
('PK-KP','PK','Khyber Pakhtunkhwa','Province'),
('PK-BA','PK','Balochistan','Province'),
('PK-IS','PK','Islamabad Capital Territory','Capital territory'),
('PK-GB','PK','Gilgit-Baltistan','Territory'),
('PK-JK','PK','Azad Jammu and Kashmir','Territory'),
('PK-FED','PK','Federal employment jurisdiction','Federal')
) v(code,country,name,kind);

CREATE TABLE staff_upload_scans (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), employee_id text NOT NULL REFERENCES employees(id),
 sha256 text NOT NULL, file_name text NOT NULL, storage_key text, created_at text NOT NULL,
 status text NOT NULL CHECK(status IN ('Pending','Scanning','Clean','Infected','Failed','Quarantined')),
 updated_at text NOT NULL
);
CREATE INDEX staff_upload_scans_recent ON staff_upload_scans(org_id,created_at DESC);
CREATE TABLE staff_upload_scan_events (
 id text PRIMARY KEY, scan_id text NOT NULL REFERENCES staff_upload_scans(id), org_id text NOT NULL REFERENCES organizations(id),
 status text NOT NULL CHECK(status IN ('Pending','Scanning','Clean','Infected','Failed','Quarantined')),
 actor_id text NOT NULL REFERENCES employees(id), created_at text NOT NULL
);
ALTER TABLE staff_upload_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_upload_scan_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE staff_upload_scans,staff_upload_scan_events FROM PUBLIC,anon,authenticated;
CREATE TRIGGER protect_staff_history BEFORE UPDATE OR DELETE ON staff_upload_scan_events
 FOR EACH ROW EXECUTE FUNCTION walshken_reject_history_mutation();
ALTER TABLE leave_requests ADD COLUMN entitlement_snapshot text;
ALTER TABLE leave_requests ADD COLUMN requested_minutes integer CHECK(requested_minutes IS NULL OR requested_minutes>=0);
CREATE TABLE staff_leave_adjustments (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), employee_id text NOT NULL REFERENCES employees(id),
 code text NOT NULL, effective_on text NOT NULL, minutes integer NOT NULL, reason text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('Opening balance','Correction','Carry forward')),
 created_by text NOT NULL REFERENCES employees(id), created_at text NOT NULL
);
CREATE TABLE staff_leave_adjustment_reviews (
 id text PRIMARY KEY, adjustment_id text NOT NULL UNIQUE REFERENCES staff_leave_adjustments(id),
 decision text NOT NULL CHECK(decision IN ('Approved','Rejected')), reason text NOT NULL,
 actor_id text NOT NULL REFERENCES employees(id), created_at text NOT NULL
);
ALTER TABLE staff_leave_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_leave_adjustment_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE staff_leave_adjustments,staff_leave_adjustment_reviews FROM PUBLIC,anon,authenticated;
CREATE TRIGGER protect_staff_history BEFORE UPDATE OR DELETE ON staff_leave_adjustments FOR EACH ROW EXECUTE FUNCTION walshken_reject_history_mutation();
CREATE TRIGGER protect_staff_history BEFORE UPDATE OR DELETE ON staff_leave_adjustment_reviews FOR EACH ROW EXECUTE FUNCTION walshken_reject_history_mutation();
ALTER TABLE staff_action_permissions DROP CONSTRAINT staff_action_permissions_scope_type_check;
ALTER TABLE staff_action_permissions ADD CONSTRAINT staff_action_permissions_scope_type_check
 CHECK(scope_type IN ('organization','division','department','employee','country','office'));
CREATE TABLE staff_retention_versions (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), country text NOT NULL CHECK(country IN ('CA','IN','PK')),
 category text NOT NULL, classification text NOT NULL, retain_days integer NOT NULL CHECK(retain_days>=0),
 minimum_days integer NOT NULL CHECK(minimum_days>=0 AND retain_days>=minimum_days),
 effective_on text NOT NULL, source_url text NOT NULL, reason text NOT NULL, created_by text NOT NULL REFERENCES employees(id), created_at text NOT NULL
);
CREATE TABLE staff_retention_reviews (
 id text PRIMARY KEY, version_id text NOT NULL UNIQUE REFERENCES staff_retention_versions(id),
 decision text NOT NULL CHECK(decision IN ('Approved','Rejected')), actor_id text NOT NULL REFERENCES employees(id), reason text NOT NULL,created_at text NOT NULL
);
CREATE TABLE staff_legal_holds (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), scope_type text NOT NULL CHECK(scope_type IN ('organization','employee','document','conversation','payroll period')),
 target_id text NOT NULL, reason text NOT NULL, created_by text NOT NULL REFERENCES employees(id),created_at text NOT NULL
);
CREATE TABLE staff_legal_hold_releases (
 hold_id text PRIMARY KEY REFERENCES staff_legal_holds(id), actor_id text NOT NULL REFERENCES employees(id),reason text NOT NULL,created_at text NOT NULL
);
DO $migration$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['staff_retention_versions','staff_retention_reviews','staff_legal_holds','staff_legal_hold_releases'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC,anon,authenticated',t);
  EXECUTE format('CREATE TRIGGER protect_staff_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION walshken_reject_history_mutation()',t);
 END LOOP;
END;
$migration$;
