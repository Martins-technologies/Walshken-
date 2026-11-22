CREATE INDEX "meeting_attendance_employee" ON "meeting_attendance" USING btree ("employee_id","meeting_id");--> statement-breakpoint
CREATE INDEX "meeting_event_meeting" ON "meeting_events" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "meeting_member_employee" ON "meeting_members" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "meeting_recording_creator" ON "meeting_recordings" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "meeting_one_active_recording" ON "meeting_recordings" USING btree ("meeting_id") WHERE "meeting_recordings"."status" in ('Starting','Active','Stopping');--> statement-breakpoint
CREATE INDEX "meeting_org_expiry" ON "meetings" USING btree ("org_id","ends_at");--> statement-breakpoint
CREATE INDEX "meeting_organizer" ON "meetings" USING btree ("organizer_id");
--> statement-breakpoint
DO $integration_policy$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='walshken_preview_app') THEN
    ALTER POLICY walshken_daily_integration ON public.integrations USING(id IN ('daily','livekit','recording-storage')) WITH CHECK(id IN ('daily','livekit','recording-storage'));
    DROP POLICY IF EXISTS walshken_livekit_integration ON public.integrations;
  END IF;
END;
$integration_policy$;
