import { clientActor } from "@/lib/walshken/customer";
import { clientPortalEnabled, withClientDb } from "@/lib/walshken/client-feature";
import { clientCallActivity, clientCallConfiguration, clientCallDecision, clientCallToken, configureClientCall, startClientCall, type CallViewer } from "@/lib/walshken/client-calls";
import { checkOrigin, cookieValue, currentActor, database, digest, fail, handleError, needsStaffMfa, payload, pick, requireStaff, str, throttle, type Db } from "@/lib/walshken/server";

export const runtime = "nodejs";
export const maxDuration = 45;
type Context = { params: Promise<{audience:string;action:string}> };

async function callViewer(db: Db, request: Request, audience: string): Promise<CallViewer> {
  if (!clientPortalEnabled() || !["client","staff"].includes(audience)) return fail(404,"Client calling is unavailable.");
  if (audience === "client") {
    const actor = await clientActor(db,request,{touch:request.method !== "GET"});
    return {side:"client",id:actor.id,name:actor.name,sessionId:actor.sessionId};
  }
  const actor = await currentActor(db,request);
  if (!actor) return fail(401,"Sign in to the workspace.");
  requireStaff(actor);
  if (needsStaffMfa(actor)) return fail(403,"Complete authenticator setup before using client calls.");
  return {side:"staff",id:actor.id,name:actor.name,actor,sessionId:await digest(cookieValue(request.headers.get("cookie")))};
}

function inViewerScope<T>(db: Db, viewer: CallViewer, work: (connection: Db) => Promise<T>) {
  return viewer.side === "client" ? withClientDb(db,viewer.id,work) : work(db);
}

export async function GET(request: Request, {params}: Context) {
  try {
    const {audience,action} = await params;
    const db = database();
    const viewer = await callViewer(db,request,audience);
    if (action === "configuration" && viewer.side === "staff") return await clientCallConfiguration(db,viewer.actor);
    if (action !== "activity") return fail(404,"Client call endpoint unavailable.");
    const caseId = str(new URL(request.url).searchParams.get("case") ?? "","case",80,false);
    return await inViewerScope(db,viewer,tx => clientCallActivity(tx,viewer,caseId));
  } catch (failure) { return handleError(failure); }
}

export async function POST(request: Request, {params}: Context) {
  try {
    checkOrigin(request);
    const {audience,action:raw} = await params;
    const db = database();
    const viewer = await callViewer(db,request,audience);
    const action = pick(raw,["start","accept","decline","end","token","configure"] as const,"call action");
    await throttle(db,`client-call:${audience}:${viewer.id}:${action}`,action === "start" ? 8 : 35,60_000);
    const data = await payload(request);
    return await inViewerScope(db,viewer,async tx => {
      if (action === "configure") {
        if (viewer.side !== "staff") return fail(403,"Company routing requires Super Admin access.");
        return configureClientCall(tx,viewer.actor,data);
      }
      if (action === "start") return startClientCall(tx,viewer,data);
      if (action === "token") return clientCallToken(tx,viewer,data);
      return clientCallDecision(tx,viewer,action,data);
    });
  } catch (failure) { return handleError(failure); }
}
