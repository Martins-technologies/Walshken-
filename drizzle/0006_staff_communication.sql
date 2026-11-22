ALTER TABLE "conversations" ADD COLUMN "status" text DEFAULT 'Active' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "department_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "closes_at" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "forwarded" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "group_creation" text DEFAULT 'Managers' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "group_approval" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "member_management" text DEFAULT 'Owners' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "message_forwarding" text DEFAULT 'Disabled' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "message_retention_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "external_messaging" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "message_changes" text DEFAULT 'Sender' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_department_id_units_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Hosted preview uses a dedicated server login. Browser-facing Data API roles keep their existing denials.
DO $preview_access$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'walshken_preview_app') THEN
    RETURN;
  END IF;

  GRANT UPDATE (group_creation, group_approval, member_management, message_forwarding,
    message_retention_days, external_messaging, message_changes)
    ON public.organizations TO walshken_preview_app;
  ALTER POLICY walshken_part_b_update ON public.organizations
    USING (id = 'walshken') WITH CHECK (id = 'walshken');

  GRANT SELECT, INSERT, UPDATE (status) ON public.conversations TO walshken_preview_app;
  CREATE POLICY walshken_communication_conversations ON public.conversations
    TO walshken_preview_app USING (org_id = 'walshken') WITH CHECK (org_id = 'walshken');

  GRANT SELECT, INSERT, UPDATE (archived, last_read_at), DELETE ON public.conversation_members TO walshken_preview_app;
  CREATE POLICY walshken_communication_members ON public.conversation_members TO walshken_preview_app
    USING (EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = conversation_members.conversation_id AND c.org_id = 'walshken'))
    WITH CHECK (
      EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = conversation_members.conversation_id AND c.org_id = 'walshken')
      AND EXISTS (SELECT 1 FROM public.employees e WHERE e.id = conversation_members.employee_id AND e.org_id = 'walshken')
    );

  GRANT SELECT, INSERT, UPDATE (body, deleted_at, edited_at, pinned) ON public.messages TO walshken_preview_app;
  CREATE POLICY walshken_communication_messages ON public.messages TO walshken_preview_app
    USING (EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = messages.conversation_id AND c.org_id = 'walshken'))
    WITH CHECK (
      EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = messages.conversation_id AND c.org_id = 'walshken')
      AND EXISTS (SELECT 1 FROM public.employees e WHERE e.id = messages.sender_id AND e.org_id = 'walshken')
    );

  GRANT SELECT, INSERT, DELETE ON public.message_reactions TO walshken_preview_app;
  CREATE POLICY walshken_communication_reactions ON public.message_reactions TO walshken_preview_app
    USING (EXISTS (SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = message_reactions.message_id AND c.org_id = 'walshken'))
    WITH CHECK (
      EXISTS (SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
        WHERE m.id = message_reactions.message_id AND c.org_id = 'walshken')
      AND EXISTS (SELECT 1 FROM public.employees e WHERE e.id = message_reactions.employee_id AND e.org_id = 'walshken')
    );

  GRANT INSERT (id, employee_id, title, body, href) ON public.notifications TO walshken_preview_app;
  CREATE POLICY walshken_communication_notifications ON public.notifications FOR INSERT TO walshken_preview_app
    WITH CHECK (
      (href = '/staff/messages' OR href LIKE '/staff/messages?conversation=%')
      AND EXISTS (SELECT 1 FROM public.employees e WHERE e.id = notifications.employee_id AND e.org_id = 'walshken')
    );
END;
$preview_access$;
