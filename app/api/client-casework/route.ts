import { requireClientCases, staffCaseAction, staffCaseView } from "@/lib/walshken/client-cases";
import { staffClientPrivacyAction, staffClientPrivacyView } from "@/lib/walshken/client-case-privacy";
import { checkOrigin, currentActor, database, fail, handleError, json, needsStaffMfa, payload, requireStaff, str } from "@/lib/walshken/server";

export const runtime="nodejs";
async function staff(request:Request){
  requireClientCases();
  const db=database(),actor=await currentActor(db,request);
  if(!actor)return fail(401,"Sign in to your staff account.");
  if(needsStaffMfa(actor))return fail(403,"Complete two-factor authentication to access client cases.");
  requireStaff(actor);
  return {db,actor};
}
export async function GET(request:Request) {
  try {
    const {db,actor}=await staff(request),params=new URL(request.url).searchParams;
    if(params.get("view")==="privacy")return json(await staffClientPrivacyView(db,actor));
    return json(await staffCaseView(db,actor,str(params.get("case"),"case",80,false),str(params.get("q"),"search",100,false)));
  }catch(error){return handleError(error);}
}
export async function POST(request:Request) {
  try {
    checkOrigin(request);
    const {db,actor}=await staff(request),data=await payload(request),action=str(data.action,"case action",40);
    if(action.startsWith("privacy-"))return await staffClientPrivacyAction(db,actor,action,data);
    return await staffCaseAction(db,actor,action,data);
  }catch(error){return handleError(error);}
}
