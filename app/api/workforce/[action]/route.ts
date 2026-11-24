import {controlsEnabled} from "@/lib/walshken/capabilities";
import {maintainReviewAttendance} from "@/lib/walshken/workforce-maintenance";
import {checkOrigin,currentActor,database,fail,handleError,json,needsStaffMfa,one,payload,canSuper} from '@/lib/walshken/server';
import {requireWorkforce,workDataset,workforceAction} from '@/lib/walshken/workforce';
import {scheduleAction} from '@/lib/walshken/scheduling';
import {workforceCsv,workforceData,workforceDetail} from '@/lib/walshken/workforce-data';
export const runtime='nodejs';export const maxDuration=300;
type Context={params:Promise<{action:string}>};
async function access(request:Request){const db=database(),actor=await currentActor(db,request);if(!actor)return fail(401,'Sign in to your staff workspace.');if(needsStaffMfa(actor))return fail(403,'Complete your authenticator setup first.');requireWorkforce(actor);return {db,actor};}
export async function GET(request:Request,{params}:Context){try{const {db,actor}=await access(request),{action}=await params,query=new URL(request.url).searchParams;if(action==='list')return await workforceData(db,actor,query);if(action==='export')return await workforceCsv(db,actor,query);if(action==='detail')return await workforceDetail(db,actor,query.get('id')??'');return fail(404,'Workforce endpoint unavailable.');}catch(e){return handleError(e);}}
export async function POST(request:Request,{params}:Context){try{checkOrigin(request);const {db,actor}=await access(request),{action}=await params,data=await payload(request);if(action==='maintenance'){if(!canSuper(actor)||workDataset()!=='preview')return fail(403,'Preview maintenance requires Super Admin access.');if(controlsEnabled())return await maintainReviewAttendance(db,actor);return json({ok:true,result:await one(db,'SELECT walshken_private.attendance_review_maintenance() AS result'),message:'Absences and missed-clock-out alerts checked.'});}if(/^(shift-|swap-|leave-|holiday-|absence-)/.test(action))return await scheduleAction(db,actor,action,data);return await workforceAction(db,actor,action,data);}catch(e){return handleError(e);}}
