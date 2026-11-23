import {checkOrigin,currentActor,database,fail,handleError,needsStaffMfa,payload} from '@/lib/walshken/server';
import {requireTasks,taskAction,taskDashboard} from '@/lib/walshken/tasks';
import {cleanupTaskFiles,taskFileAction,taskFileContent,taskFileUpload} from '@/lib/walshken/task-files';
export const runtime='nodejs';
export const maxDuration=60;
type Context={params:Promise<{action:string}>};
async function access(request:Request){const db=database(),actor=await currentActor(db,request);if(!actor)return fail(401,'Sign in to your staff workspace.');if(needsStaffMfa(actor))return fail(403,'Complete authenticator setup before accessing tasks.');requireTasks(actor);return {db,actor};}
export async function GET(request:Request,{params}:Context){try{const {db,actor}=await access(request),{action}=await params;if(action==='list')return await taskDashboard(db,actor,new URL(request.url).searchParams);if(action==='file')return await taskFileContent(db,actor,request);return fail(404,'Task endpoint unavailable.');}catch(error){return handleError(error);}}
export async function POST(request:Request,{params}:Context){try{checkOrigin(request);const {db,actor}=await access(request),{action}=await params;if(action==='upload')return await taskFileUpload(db,actor,request);if(action==='cleanup')return await cleanupTaskFiles(db,actor);const data=await payload(request);if(['file-access','file-remove'].includes(action))return await taskFileAction(db,actor,action,data,request);return await taskAction(db,actor,action,data);}catch(error){return handleError(error);}}
