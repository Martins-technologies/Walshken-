import {staffCaseFor} from "@/lib/walshken/client-cases";
import {clientPortalEnabled} from "@/lib/walshken/client-feature";
import {financeDownload,financeView,staffFinanceAction} from "@/lib/walshken/client-finance";
import {checkOrigin,currentActor,database,fail,handleError,json,needsStaffMfa,payload,requireStaff,str,throttle} from "@/lib/walshken/server";

export const runtime="nodejs";

async function access(request:Request) {
  if(!clientPortalEnabled())return fail(404,"Client finance is unavailable.");
  const db=database(),actor=await currentActor(db,request);
  if(!actor)return fail(401,"Sign in to your staff workspace.");
  requireStaff(actor);
  if(needsStaffMfa(actor))return fail(403,"Complete your authenticator setup first.");
  return {db,actor};
}

export async function GET(request:Request) {
  try{
    const {db,actor}=await access(request),params=new URL(request.url).searchParams;
    await throttle(db,"staff-client-finance-view:"+actor.id,75,60_000);
    const c=await staffCaseFor(db,actor,str(params.get("caseId"),"case",80));
    const scope={orgId:c.org_id,customerId:c.customer_id,caseId:c.id};
    return params.has("kind")?await financeDownload(db,scope,params,actor):json(await financeView(db,scope,actor));
  }catch(error){return handleError(error);}
}

export async function POST(request:Request) {
  try{
    checkOrigin(request);
    const {db,actor}=await access(request),data=await payload(request);
    await throttle(db,"staff-client-finance-action:"+actor.id,36,60_000);
    return json(await staffFinanceAction(db,actor,data));
  }catch(error){return handleError(error);}
}
