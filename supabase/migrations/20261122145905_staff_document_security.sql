-- Additive Part D schema. No production document routes or existing data are changed.
CREATE TABLE public.doc_folders(
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),parent_id text REFERENCES doc_folders(id),
 name text NOT NULL,department_id text REFERENCES units(id),group_id text REFERENCES conversations(id),
 created_by text NOT NULL REFERENCES employees(id),revoked_at text,created_at text NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 CHECK(parent_id IS NULL OR parent_id<>id)
);
CREATE INDEX doc_folders_org_parent ON public.doc_folders(org_id,parent_id);
CREATE TABLE public.doc_entries(
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),folder_id text REFERENCES doc_folders(id),
 department_id text REFERENCES units(id),group_id text REFERENCES conversations(id),owner_id text NOT NULL REFERENCES employees(id),
 name text NOT NULL,description text NOT NULL DEFAULT '',category text NOT NULL DEFAULT 'General document',current_version text,
 watermark integer NOT NULL DEFAULT 0 CHECK(watermark IN(0,1)),revoked_at text,deleted_at text,
 created_at text NOT NULL,updated_at text NOT NULL
);
CREATE INDEX doc_entries_org_folder ON public.doc_entries(org_id,folder_id,updated_at DESC);
CREATE TABLE public.doc_versions(
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),document_id text NOT NULL REFERENCES doc_entries(id),
 version integer NOT NULL,filename text NOT NULL,mime text NOT NULL,bytes integer NOT NULL CHECK(bytes>0 AND bytes<=3145728),
 sha256 text NOT NULL,storage_key text NOT NULL UNIQUE,page_count integer NOT NULL CHECK(page_count>0 AND page_count<=200),
 created_by text NOT NULL REFERENCES employees(id),created_at text NOT NULL,note text NOT NULL DEFAULT '',UNIQUE(document_id,version)
);
ALTER TABLE public.doc_entries ADD CONSTRAINT doc_entries_current_version_fk FOREIGN KEY(current_version) REFERENCES doc_versions(id);
CREATE TABLE public.doc_acl(
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),
 scope_type text NOT NULL CHECK(scope_type IN('organization','department','group','folder','document')),scope_id text NOT NULL,
 principal_type text NOT NULL CHECK(principal_type IN('all','employee','role','department','group')),principal_id text NOT NULL,
 effect text NOT NULL CHECK(effect IN('allow','deny')),mask integer NOT NULL CHECK(mask>0 AND mask<=511),expires_at text,
 created_by text NOT NULL REFERENCES employees(id),source_document text REFERENCES doc_entries(id),source_actor text REFERENCES employees(id),created_at text NOT NULL
);
CREATE INDEX doc_acl_lookup ON public.doc_acl(org_id,scope_type,scope_id);
CREATE INDEX doc_acl_source ON public.doc_acl(source_document,source_actor);
CREATE TABLE public.doc_events(
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),actor_id text NOT NULL REFERENCES employees(id),
 document_id text REFERENCES doc_entries(id),folder_id text REFERENCES doc_folders(id),action text NOT NULL,detail text NOT NULL DEFAULT '',
 recipient_id text REFERENCES employees(id),version_id text REFERENCES doc_versions(id),created_at text NOT NULL
);
CREATE INDEX doc_events_org_time ON public.doc_events(org_id,created_at DESC);
CREATE INDEX doc_events_document_time ON public.doc_events(document_id,created_at DESC);
-- Durable object deletion queue; logical delete and revocation apply immediately.
CREATE TABLE public.doc_object_cleanup(id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),storage_key text NOT NULL UNIQUE,created_at text NOT NULL);
DO $rls$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['doc_folders','doc_entries','doc_versions','doc_acl','doc_events','doc_object_cleanup'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON public.%I FROM anon',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON public.%I FROM authenticated',t); END IF;
 END LOOP;
END;
$rls$;
