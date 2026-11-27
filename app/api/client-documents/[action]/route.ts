import { clientActor } from "@/lib/walshken/customer";
import { clientPortalEnabled, withClientDb } from "@/lib/walshken/client-feature";
import { clientDocumentAction, listClientDocuments, uploadClientDocument, viewClientDocument, type ClientDocumentViewer } from "@/lib/walshken/client-documents";
import { checkOrigin, cookieValue, currentActor, database, fail, handleError, needsStaffMfa, payload, str, type Db } from "@/lib/walshken/server";

export const runtime="nodejs";
export const maxDuration=60;
type Context={params:Promise<{action:string}>};

async function viewerFor(db:Db,request:Request,staff:boolean,touch:boolean,recent=false):Promise<ClientDocumentViewer> {
  if(!clientPortalEnabled())return fail(404,"The client portal is unavailable.");
  if(staff){
    const actor=await currentActor(db,request);
    if(!actor||actor.role==="guest")return fail(401,"Sign in as an authorized staff member.");
    if(needsStaffMfa(actor))return fail(403,"Complete staff authenticator setup first.");
    return {id:actor.id,kind:"staff",actor,session:cookieValue(request.headers.get("cookie"))};
  }
  const actor=await clientActor(db,request,{touch,recent});
  if(!actor)return fail(401,"Sign in to your verified client account.");
  return {id:actor.id,kind:"client",session:actor.sessionId};
}

export async function GET(request:Request,{params}:Context){
  try{
    const {action}=await params,p=new URL(request.url).searchParams,staff=p.get("scope")==="staff",db=database();
    const authenticate=()=>viewerFor(db,request,staff,false,action==="download");
    const viewer=await authenticate();
    if(action==="list"){
      const read=(tx:Db)=>listClientDocuments(tx,viewer,str(p.get("case"),"case",80),str(p.get("document"),"document",80,false));
      return await (viewer.kind==="client"?withClientDb(db,viewer.id,read):read(db));
    }
    if(action==="access"||action==="preview"||action==="download")return await viewClientDocument(db,viewer,request,action,authenticate);
    return fail(404,"Document endpoint unavailable.");
  }catch(error){return handleError(error);}
}

export async function POST(request:Request,{params}:Context){
  try{
    checkOrigin(request);
    const {action}=await params,staff=new URL(request.url).searchParams.get("scope")==="staff",db=database();
    const viewer=await viewerFor(db,request,staff,true);
    if(action==="upload")return await uploadClientDocument(db,viewer,request);
    const data=await payload(request),change=(tx:Db)=>clientDocumentAction(tx,viewer,action,data);
    return await (viewer.kind==="client"?withClientDb(db,viewer.id,change):change(db));
  }catch(error){return handleError(error);}
}
