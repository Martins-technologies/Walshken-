import { timingSafeEqual } from "node:crypto";
import { maintainMeetings } from "@/lib/walshken/meetings";
import { database, fail, handleError, json } from "@/lib/walshken/server";
export const runtime="nodejs";
export const maxDuration=60;
export async function GET(request:Request){
  try{
    const secret=process.env.CRON_SECRET,provided=request.headers.get("authorization")??"";
    if(!secret)return fail(503,"Calling maintenance is awaiting server configuration.");
    const expected=`Bearer ${secret}`;
    if(Buffer.byteLength(provided)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(provided),Buffer.from(expected)))return fail(401,"Unauthorized.");
    const result=await maintainMeetings(database());return json(result,result.errors.length?503:200);
  }catch(error){return handleError(error);}
}
