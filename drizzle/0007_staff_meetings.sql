ALTER TABLE "meeting_members" ADD COLUMN "requested_at" text;--> statement-breakpoint
ALTER TABLE "meeting_members" ADD COLUMN "admitted_at" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "mode" text DEFAULT 'Video' NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "waiting_room" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "screen_sharing" text DEFAULT 'Everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "cancelled_at" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "external_meetings" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DO $preview_access$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'walshken_preview_app') THEN
    RETURN;
  END IF;

  GRANT UPDATE (external_meetings) ON public.organizations TO walshken_preview_app;

  GRANT SELECT, INSERT, UPDATE (cancelled_at, provider_room) ON public.meetings TO walshken_preview_app;
  CREATE POLICY walshken_meeting_namespace ON public.meetings TO walshken_preview_app
    USING (org_id = 'walshken') WITH CHECK (org_id = 'walshken');

  GRANT SELECT, INSERT, UPDATE (requested_at, admitted_at) ON public.meeting_members TO walshken_preview_app;
  CREATE POLICY walshken_meeting_invitees ON public.meeting_members TO walshken_preview_app
    USING (EXISTS (SELECT 1 FROM public.meetings m WHERE m.id = meeting_members.meeting_id AND m.org_id = 'walshken'))
    WITH CHECK (
      EXISTS (SELECT 1 FROM public.meetings m WHERE m.id = meeting_members.meeting_id AND m.org_id = 'walshken')
      AND EXISTS (SELECT 1 FROM public.employees e WHERE e.id = meeting_members.employee_id AND e.org_id = 'walshken')
    );

  CREATE POLICY walshken_meeting_notifications ON public.notifications FOR INSERT TO walshken_preview_app
    WITH CHECK ((href = '/staff/calls' OR href LIKE '/staff/calls?meeting=%')
      AND EXISTS (SELECT 1 FROM public.employees e WHERE e.id = notifications.employee_id AND e.org_id = 'walshken'));

  GRANT SELECT, INSERT, UPDATE (configuration, enabled, updated_at) ON public.integrations TO walshken_preview_app;
  CREATE POLICY walshken_daily_integration ON public.integrations TO walshken_preview_app
    USING (id = 'daily') WITH CHECK (id = 'daily');
END;
$preview_access$;
