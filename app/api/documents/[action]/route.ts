import { checkOrigin,currentActor,database,fail,handleError,needsStaffMfa,payload } from "@/lib/walshken/server";
import { cleanupDocumentObjects,documentAction,documentContent,documentList,uploadManagedDocument } from "@/lib/walshken/documents";
import { requireDocuments } from "@/lib/walshken/document-access";
export const runtime="nodejs";
export const maxDuration=60;
type Context={params:Promise<{action:string}>};
async function actor(request:Request){requireDocuments();const db=database(),user=await currentActor(db,request);if(!user)return fail(401,"Sign in to your staff account.");if(needsStaffMfa(user))return fail(403,"Complete authenticator setup before accessing documents.");return {db,user};}
export async function GET(request:Request,{params}:Context){try{const {db,user}=await actor(request),{action}=await params;if(action==="content")return await documentContent(db,user,request);if(action==="list")return await documentList(db,user);return fail(404,"Document endpoint unavailable.");}catch(error){return handleError(error);}}
export async function POST(request:Request,{params}:Context){try{checkOrigin(request);const {db,user}=await actor(request),{action}=await params;if(action==="upload")return await uploadManagedDocument(db,user,request);const response=await documentAction(db,user,action,await payload(request),request);if(action==="delete"&&response.ok)await cleanupDocumentObjects(db,user);return response;}catch(error){return handleError(error);}}
