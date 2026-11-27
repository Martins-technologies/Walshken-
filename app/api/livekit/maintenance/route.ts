import {processInternalMeetingReminders} from "@/lib/walshken/meeting-invitations";
import { maintainClientCalls } from "@/lib/walshken/client-calls";
import { clientPortalEnabled } from "@/lib/walshken/client-feature";
import { maintainClientDocuments } from "@/lib/walshken/client-documents";
import { processClientNotificationEmails } from "@/lib/walshken/client-notifications";
import { maintainClientAppointmentReminders } from "@/lib/walshken/client-appointments";
import { remindClientPayments } from "@/lib/walshken/client-payment-plans";
import { purgeExpiredClientChallenges } from "@/lib/walshken/client-auth";
import {processMeetingInvitationEmails} from "@/lib/walshken/meeting-invitation-email";
import {maintainProjects} from "@/lib/walshken/projects";
import {processNotificationEmails} from "@/lib/walshken/notification-email";
import { maintenanceAuthorized } from "@/lib/walshken/maintenance-auth";
import { maintainMeetings } from "@/lib/walshken/meetings";
import { database, fail, handleError, json, orgId } from "@/lib/walshken/server";
export const runtime="nodejs";
export const maxDuration=60;
export async function GET(request:Request){
  try{
    const secret=process.env.CRON_SECRET,provided=request.headers.get("authorization")??"";
    if(!secret)return fail(503,"Calling maintenance is awaiting server configuration.");
    if(!maintenanceAuthorized(provided,secret,process.env.VERCEL_ENV==="preview"))return fail(401,"Unauthorized.");
    const started=Date.now(),db=database();
    const result=await maintainMeetings(db);
    const projects=await maintainProjects(db);
    const meetingReminders=await processInternalMeetingReminders(db,orgId);
    const clientPortal = clientPortalEnabled() ? {
      calls: await maintainClientCalls(db,orgId),
      documents: await maintainClientDocuments(db,orgId),
      appointments: await maintainClientAppointmentReminders(db,orgId),
      payments: await remindClientPayments(db),
      expiredChallenges: await purgeExpiredClientChallenges(db),
      notifications: await processClientNotificationEmails(db,Math.max(0,Math.min(8500,41000-(Date.now()-started)))),
    } : undefined;
    const [notificationEmails,meetingInvitationEmails]=await Promise.all([
      processNotificationEmails(db,Math.max(0,Math.min(12000,45000-(Date.now()-started)))),
      processMeetingInvitationEmails(db,Math.max(0,Math.min(11000,45000-(Date.now()-started)))),
    ]);
    return json({...result,projects,meetingReminders,notificationEmails,meetingInvitationEmails,clientPortal},result.errors.length?503:200);
  }catch(error){return handleError(error);}
}
