import { staffMfaAction } from "@/lib/walshken/staff-mfa";
import { closeOtherSessions, removeAvatar, staffAvatar, updateAvatar } from "@/lib/walshken/staff-profile";
import { adminAction } from "@/lib/walshken/admin";
import { changePassword, login } from "@/lib/walshken/auth";
import { documentAction, downloadDocument, meetingAction, messageAction, messagesFor, uploadDocument } from "@/lib/walshken/collaboration";
import { checkOrigin, currentActor, database, endSession, fail, handleError, json, needsStaffMfa, payload, pick, requireStaff } from "@/lib/walshken/server";
import { view } from "@/lib/walshken/views";
import { payrollAction, taskDetails, timeAction, workAction } from "@/lib/walshken/work";

export const runtime = "nodejs";
type Context = { params: Promise<{ parts: string[] }> };

export async function GET(request: Request, context: Context) {
  try {
    const [area, action] = (await context.params).parts;
    const db = database();
    const actor = await currentActor(db, request);
    if (!actor) return fail(401,"Sign in to your staff workspace.");
    if (needsStaffMfa(actor) && (area !== "view" || action !== "profile")) {
      return fail(403, "Set up your authenticator before using the staff workspace.");
    }
    const params = new URL(request.url).searchParams;
    if (area === "profile" && action === "photo") return await staffAvatar(db, actor);
    if (area === "view") return await view(db,actor,action,params);
    if (area === "files") return await downloadDocument(db,actor,action,params.get("mode")==="preview");
    if (area === "conversation") return await messagesFor(db,actor,action,params.get("q")??"",params.get("before")??"");
    if (area === "task-comments") { requireStaff(actor); return json({rows:await taskDetails(db,actor,action)}); }
    return fail(404,"This workspace endpoint is unavailable.");
  } catch (error) { return handleError(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    checkOrigin(request);
    const [area, action] = (await context.params).parts;
    if(area==="session"&&["login","bootstrap","activate","recover"].includes(action)) return await login(request,pick(action,["login","bootstrap","activate","recover"],"access method"),await payload(request));
    const db=database();
    const actor=await currentActor(db,request);
    if(!actor) return fail(401,"Sign in to your staff workspace.");
    if(area==="session"&&action==="logout") return await endSession(request,db,actor);
    if(needsStaffMfa(actor) && (area!=="mfa" || !["setup","confirm"].includes(action))) {
      return fail(403,"Set up your authenticator before using the staff workspace.");
    }
    if(area==="session"&&action==="close-others") return await closeOtherSessions(db,actor,request);
    if(area==="profile"&&action==="photo") return await updateAvatar(db,actor,request);
    if(area==="profile"&&action==="remove-photo") return await removeAvatar(db,actor);
    if(area==="documents"&&action==="upload") return await uploadDocument(db,actor,request);
    const data=await payload(request);
    if(area==="mfa") return await staffMfaAction(request,db,actor,action,data);
    if(area==="session"&&action==="password") return await changePassword(request,db,actor,data);
    if(["employees","organization","website","integrations","holidays","communication-policy"].includes(area)) return await adminAction(db,actor,area,action,data);
    if(["attendance","timesheets","shifts","leave","corrections"].includes(area)) return await timeAction(db,actor,area,action,data);
    if(["tasks","projects","notifications"].includes(area)) return await workAction(db,actor,area,action,data);
    if(area==="messages") return await messageAction(db,actor,action,data);
    if(area==="documents") return await documentAction(db,actor,action,data);
    if(area==="calls") return await meetingAction(db,actor,action,data);
    if(area==="payroll") return await payrollAction(db,actor,action,data);
    return fail(404,"This workspace endpoint is unavailable.");
  } catch(error) { return handleError(error); }
}
