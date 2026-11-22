CREATE TABLE "meeting_attendance" (
	"id" text PRIMARY KEY NOT NULL,
	"meeting_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"participant_sid" text NOT NULL,
	"joined_at" text,
	"left_at" text,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "meeting_events" (
	"id" text PRIMARY KEY NOT NULL,
	"meeting_id" text NOT NULL,
	"event" text NOT NULL,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_recordings" (
	"id" text PRIMARY KEY NOT NULL,
	"meeting_id" text NOT NULL,
	"created_by" text NOT NULL,
	"egress_id" text,
	"object_key" text NOT NULL,
	"storage_id" text DEFAULT 'recording-storage' NOT NULL,
	"status" text NOT NULL,
	"started_at" text,
	"ended_at" text,
	"expires_at" text NOT NULL,
	"deleted_at" text,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_members" ADD COLUMN "removed_at" text;--> statement-breakpoint
ALTER TABLE "meeting_members" ADD COLUMN "can_publish" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_members" ADD COLUMN "can_share" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_members" ADD COLUMN "co_host" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_members" ADD COLUMN "recording_consent" integer;--> statement-breakpoint
ALTER TABLE "meeting_members" ADD COLUMN "consent_at" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "provider" text DEFAULT 'livekit' NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "started_at" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "ended_at" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "end_reason" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "locked_at" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "recording_enabled" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "recording_retention_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "recording_policy" text DEFAULT 'Disabled' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "recording_retention_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_events" ADD CONSTRAINT "meeting_events_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_recordings" ADD CONSTRAINT "meeting_recordings_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_recordings" ADD CONSTRAINT "meeting_recordings_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_attendance_sid" ON "meeting_attendance" USING btree ("participant_sid");--> statement-breakpoint
CREATE INDEX "meeting_attendance_meeting" ON "meeting_attendance" USING btree ("meeting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_recording_egress" ON "meeting_recordings" USING btree ("egress_id");--> statement-breakpoint
CREATE INDEX "meeting_recording_expiry" ON "meeting_recordings" USING btree ("expires_at");--> statement-breakpoint
-- Preserve existing Daily room references without treating them as LiveKit rooms.
UPDATE public.meetings SET provider='daily' WHERE provider_room IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX meeting_one_active_recording ON public.meeting_recordings (meeting_id) WHERE status IN ('Starting','Active','Stopping');
--> statement-breakpoint
ALTER TABLE public.meeting_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_recordings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.meeting_attendance,public.meeting_events,public.meeting_recordings FROM PUBLIC;
--> statement-breakpoint
DO $calling_access$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.meeting_attendance,public.meeting_events,public.meeting_recordings FROM anon,authenticated;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='walshken_preview_app') THEN RETURN; END IF;
  GRANT UPDATE (recording_policy,recording_retention_days) ON public.organizations TO walshken_preview_app;
  GRANT UPDATE (started_at,ended_at,end_reason,locked_at,recording_enabled,recording_retention_days) ON public.meetings TO walshken_preview_app;
  GRANT UPDATE (removed_at,co_host,can_publish,can_share,recording_consent,consent_at) ON public.meeting_members TO walshken_preview_app;
  CREATE POLICY walshken_livekit_integration ON public.integrations TO walshken_preview_app USING(id IN ('livekit','recording-storage')) WITH CHECK(id IN ('livekit','recording-storage'));
  FOREACH t IN ARRAY ARRAY['meeting_attendance','meeting_events','meeting_recordings'] LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.%I TO walshken_preview_app',t);
    EXECUTE format('CREATE POLICY walshken_calling_scope ON public.%I TO walshken_preview_app USING (EXISTS(SELECT 1 FROM public.meetings m WHERE m.id=meeting_id AND m.org_id=''walshken'')) WITH CHECK (EXISTS(SELECT 1 FROM public.meetings m WHERE m.id=meeting_id AND m.org_id=''walshken''))',t);
  END LOOP;
END;
$calling_access$;
