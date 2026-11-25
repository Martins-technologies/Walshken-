import {guestMeetingAction, meetingInvitesEnabled} from "@/lib/walshken/meeting-invitations";
import {checkOrigin, database, digest, fail, handleError, payload, throttle} from "@/lib/walshken/server";
export const runtime = "nodejs";
const actions = ["exchange","status","accept","decline","join","leave","consent"];
export async function POST(request:Request, context:{params:Promise<{action:string}>}) {
  try {
    if(!meetingInvitesEnabled())return fail(404,"External meeting invitations are unavailable.");
    checkOrigin(request);
    const {action}=await context.params;
    if (!actions.includes(action)) return fail(404,"Meeting access action unavailable.");
    const data=await payload(request);
    const db=database();
    const ip=request.headers.get("x-vercel-forwarded-for") || "local";
    await throttle(db,`external-meeting:${action}:${await digest(ip.slice(0,200))}`,action==="exchange"?40:240,60_000);
    return await guestMeetingAction(db,request,action,data);
  } catch(error) { return handleError(error); }
}
