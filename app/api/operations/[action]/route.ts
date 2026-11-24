import {calculatorContract} from "@/lib/walshken/calculator-contract";
import {checkOrigin,currentActor,database,fail,handleError,needsStaffMfa,payload,canSuper,json} from '@/lib/walshken/server';
import {operationsAction,operationsData} from '@/lib/walshken/operations';
export const runtime='nodejs';export const maxDuration=300;
type Context={params:Promise<{action:string}>};
async function access(request:Request){const db=database(),actor=await currentActor(db,request);if(!actor)return fail(401,'Sign in to the staff portal.');if(needsStaffMfa(actor))return fail(403,'Complete two-factor authentication first.');return {db,actor};}
export async function GET(request:Request,{params}:Context){try{const {db,actor}=await access(request),{action}=await params;if(action==='calculator-contract'){if(!canSuper(actor))return fail(403,'Super Admin required.');return json(calculatorContract,200,{'Content-Disposition':'attachment; filename="walshken-calculator-contract.json"'});}if(action!=='list')return fail(404,'Endpoint unavailable.');return await operationsData(db,actor,new URL(request.url).searchParams);}catch(e){return handleError(e);}}
export async function POST(request:Request,{params}:Context){try{checkOrigin(request);const {db,actor}=await access(request),{action}=await params;return await operationsAction(db,actor,action,await payload(request));}catch(e){return handleError(e);}}
