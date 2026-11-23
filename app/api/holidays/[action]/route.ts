import {checkOrigin,currentActor,database,fail,handleError,needsStaffMfa,payload} from '@/lib/walshken/server';
import {requireHolidays} from '@/lib/walshken/holiday-access';
import {holidayAction} from '@/lib/walshken/holiday-actions';
import {holidayCsv,holidayData,holidayFactsResponse,privateEmploymentRecord} from '@/lib/walshken/holiday-data';
export const runtime='nodejs';export const maxDuration=300;
type Context={params:Promise<{action:string}>};
async function access(request:Request){const db=database(),actor=await currentActor(db,request);if(!actor)return fail(401,'Sign in to your staff workspace.');if(needsStaffMfa(actor))return fail(403,'Complete your authenticator setup first.');requireHolidays(actor);return {db,actor};}
export async function GET(request:Request,{params}:Context){try{const {db,actor}=await access(request),action=(await params).action,q=new URL(request.url).searchParams;if(action==='list')return await holidayData(db,actor,q);if(action==='facts')return await holidayFactsResponse(db,actor,q);if(action==='private-record')return await privateEmploymentRecord(db,actor,q.get('employee')??actor.id);if(action==='export')return await holidayCsv(db,actor,q);return fail(404,'Holiday endpoint unavailable.');}catch(e){return handleError(e);}}
export async function POST(request:Request,{params}:Context){try{checkOrigin(request);const {db,actor}=await access(request);return await holidayAction(db,actor,(await params).action,await payload(request));}catch(e){return handleError(e);}}
