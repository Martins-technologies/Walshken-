import { downloadProjectDeliverable, uploadProjectDeliverable } from "@/lib/walshken/project-deliverables";
import { checkOrigin, currentActor, database, fail, handleError, needsStaffMfa } from "@/lib/walshken/server";

export const runtime = "nodejs";

async function processDeliverable(request: Request, method: typeof uploadProjectDeliverable) {
  try {
    if(request.method==="POST")checkOrigin(request);
    const db=database(), actor=await currentActor(db,request);
    if(!actor||needsStaffMfa(actor))return fail(401,"Sign in to your staff workspace.");
    return await method(db,actor,request);
  } catch(error){ return handleError(error); }
}

export const GET = (request:Request) => processDeliverable(request,downloadProjectDeliverable);
export const POST = (request:Request) => processDeliverable(request,uploadProjectDeliverable);
