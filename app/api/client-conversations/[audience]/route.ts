import { requireClientCases } from "@/lib/walshken/client-cases";
import { conversationAction, conversationView, officeConversationInbox } from "@/lib/walshken/client-conversations";
import { withClientDb } from "@/lib/walshken/client-feature";
import { clientActor } from "@/lib/walshken/customer";
import { checkOrigin, currentActor, database, fail, handleError, json, needsStaffMfa, payload, str, type Db } from "@/lib/walshken/server";

export const runtime="nodejs";
type Context={params:Promise<{audience:string}>};

async function staffViewer(db:Db,request:Request){
  const actor=await currentActor(db,request);
  if(!actor||actor.role==="guest")return fail(401,"Sign in as an authorized staff member.");
  if(needsStaffMfa(actor))return fail(403,"Complete staff authenticator setup first.");
  return {side:"staff" as const,actor};
}

export async function GET(request:Request,{params}:Context){
  try{
    requireClientCases();
    const db=database(),{audience}=await params,query=new URL(request.url).searchParams;
    const target=str(query.get("case"),"case",80,false),endpoint=str(query.get("endpoint"),"office",80,false),before=str(query.get("before"),"message page",80,false);
    if(audience==="staff"){
      const viewer=await staffViewer(db,request);
      if(!target)return json({inbox:await officeConversationInbox(db,viewer.actor)});
      return json(await conversationView(db,viewer,target,endpoint,before));
    }
    if(audience!=="client")return fail(404,"This conversation is unavailable.");
    const actor=await clientActor(db,request,{touch:false});
    return await withClientDb(db,actor.id,async tx=>json(await conversationView(tx,{side:"client",actor},target,endpoint,before)));
  }catch(error){return handleError(error);}
}

export async function POST(request:Request,{params}:Context){
  try{
    requireClientCases();checkOrigin(request);
    const db=database(),{audience}=await params,data=await payload(request);
    if(audience==="staff")return await conversationAction(db,await staffViewer(db,request),data);
    if(audience!=="client")return fail(404,"This conversation is unavailable.");
    const actor=await clientActor(db,request,{touch:true});
    return await withClientDb(db,actor.id,tx=>conversationAction(tx,{side:"client",actor},data));
  }catch(error){return handleError(error);}
}
