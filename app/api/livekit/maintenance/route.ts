import {processInternalMeetingReminders} from "@/lib/walshken/meeting-invitations";
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
    const [notificationEmails,meetingInvitationEmails]=await Promise.all([
      processNotificationEmails(db,Math.max(0,Math.min(12000,45000-(Date.now()-started)))),
      processMeetingInvitationEmails(db,Math.max(0,Math.min(11000,45000-(Date.now()-started)))),
    ]);
    return json({...result,projects,meetingReminders,notificationEmails,meetingInvitationEmails},result.errors.length?503:200);
  }catch(error){return handleError(error);}
}
