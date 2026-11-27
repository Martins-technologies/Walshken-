import {recordClientEmailEvent} from "@/lib/walshken/client-email-events";
import {clientPortalEnabled} from "@/lib/walshken/client-feature";
import {database,fail,handleError} from "@/lib/walshken/server";

export const runtime="nodejs";
export async function POST(request:Request){
  try{
    if(!clientPortalEnabled())return fail(404,"Client Portal is unavailable.");
    return await recordClientEmailEvent(database(),request);
  }catch(error){return handleError(error);}
}
