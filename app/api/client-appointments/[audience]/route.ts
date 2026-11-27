import { appointmentCalendar, clientAppointments, updateClientAppointment } from "@/lib/walshken/client-appointments";
import type { CallViewer } from "@/lib/walshken/client-calls";
import { clientPortalEnabled, withClientDb } from "@/lib/walshken/client-feature";
import { clientActor } from "@/lib/walshken/client-sessions";
import { checkOrigin, cookieValue, currentActor, database, digest, fail, handleError, needsStaffMfa, payload, pick, requireStaff, str, throttle, type Db } from "@/lib/walshken/server";

export const runtime = "nodejs";
type Context = { params:Promise<{audience:string}> };

async function viewerFor(db:Db, request:Request, audience:string):Promise<CallViewer> {
  if (audience==="client") {
    const account=await clientActor(db,request,{touch:request.method!=="GET"});
    return {side:"client",id:account.id,name:account.name,sessionId:account.sessionId};
  }
  if (audience!=="staff") return fail(404,"Appointment endpoint unavailable.");
  const actor=await currentActor(db,request);
  if (!actor) return fail(401,"Sign in to Staff casework.");
  requireStaff(actor);
  if (needsStaffMfa(actor)) return fail(403,"Complete staff authentication before using appointments.");
  return {side:"staff",id:actor.id,name:actor.name,actor,sessionId:await digest(cookieValue(request.headers.get("cookie")))};
}

export async function GET(request:Request,{params}:Context) {
  try {
    if (!clientPortalEnabled()) return fail(404,"Appointments are unavailable.");
    const db=database(), {audience}=await params, viewer=await viewerFor(db,request,audience);
    const query=new URL(request.url).searchParams;
    const caseId=str(query.get("case"),"case",80), schedule=query.get("view");
    const scoped=(connection:Db)=>schedule==="calendar"
      ? appointmentCalendar(connection,viewer,caseId,str(query.get("appointment"),"appointment",80))
      : clientAppointments(connection,viewer,caseId,schedule==="summary");
    return await (viewer.side==="client" ? withClientDb(db,viewer.id,scoped) : scoped(db));
  } catch (error) { return handleError(error); }
}

export async function POST(request:Request,{params}:Context) {
  try {
    if (!clientPortalEnabled()) return fail(404,"Appointments are unavailable.");
    checkOrigin(request);
    const db=database(), {audience}=await params, viewer=await viewerFor(db,request,audience);
    const data=await payload(request), caseId=str(data.case,"case",80);
    const action=pick(data.action,["publish","withdraw","book","reschedule","cancel","complete","join"] as const,"appointment action");
    await throttle(db,`client-appointment:${viewer.side}:${viewer.id}:${action}`,action==="join"?8:20,60_000);
    const scoped=(connection:Db)=>updateClientAppointment(connection,viewer,caseId,action,data);
    return await (viewer.side==="client" ? withClientDb(db,viewer.id,scoped) : scoped(db));
  } catch (error) { return handleError(error); }
}
