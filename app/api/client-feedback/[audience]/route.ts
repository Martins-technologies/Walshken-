import { requireClientCases } from "@/lib/walshken/client-cases";
import { clientFeedbackView, reviewClientFeedback, staffFeedbackView, submitClientFeedback } from "@/lib/walshken/client-feedback";
import { withClientDb } from "@/lib/walshken/client-feature";
import { clientActor } from "@/lib/walshken/customer";
import { checkOrigin, currentActor, database, fail, handleError, json, needsStaffMfa, payload, str, type Db } from "@/lib/walshken/server";

export const runtime="nodejs";
type Context={params:Promise<{audience:string}>};

async function staff(db:Db,request:Request){
  const actor=await currentActor(db,request);
  if(!actor)return fail(401,"Sign in as an authorized staff member.");
  if(needsStaffMfa(actor))return fail(403,"Complete staff authenticator setup first.");
  return actor;
}

export async function GET(request:Request,{params}:Context){
  try{
    requireClientCases();
    const db=database(),{audience}=await params,query=new URL(request.url).searchParams;
    if(audience==="staff")return json(await staffFeedbackView(db,await staff(db,request),query));
    if(audience!=="client")return fail(404,"This feedback area is unavailable.");
    const actor=await clientActor(db,request,{touch:false});
    return await withClientDb(db,actor.id,async tx=>json(await clientFeedbackView(tx,actor.id,str(query.get("id"),"submission",80,false))));
  }catch(error){return handleError(error);}
}

export async function POST(request:Request,{params}:Context){
  try{
    requireClientCases();checkOrigin(request);
    const db=database(),{audience}=await params,data=await payload(request);
    if(audience==="staff")return await reviewClientFeedback(db,await staff(db,request),data);
    if(audience!=="client")return fail(404,"This feedback area is unavailable.");
    const actor=await clientActor(db,request,{touch:true});
    return await withClientDb(db,actor.id,tx=>submitClientFeedback(tx,actor.id,data));
  }catch(error){return handleError(error);}
}
