import {scanStaffUpload} from "./staff-delivery";
import { createHash,createHmac,timingSafeEqual } from "node:crypto";
import { GetObjectCommand,PutObjectCommand,DeleteObjectCommand } from "@aws-sdk/client-s3";
import { storageClient,validateStorage } from "./livekit";
import { documentStorage } from "./document-storage";
import { inspectDocument,renderDocumentPage } from "./document-render";
import { documentLimits } from "./document-types";
import { all,canManage,cookieValue,currentActor,digest,fail,id,integer,json,needsStaffMfa,now,one,run,str,throttle,type Actor,type Db } from "./server";
import { requireTasks,taskDataset,taskEvent,taskFor } from "./tasks";
import type { TaskFile } from "./task-types";
async function storage(db:Db){const settings=await documentStorage(db),bucket=process.env.WALSHKEN_TASK_BUCKET;if(!bucket||[settings.bucket,"walshken-call-recordings"].includes(bucket))return fail(503,"Configure a separate private task-file bucket.");return validateStorage({...settings,bucket});}
async function removeObject(db:Db,key:string){const s=await storage(db),client=storageClient(s);try{await client.send(new DeleteObjectCommand({Bucket:s.bucket,Key:key}));}finally{client.destroy();}}
function editable(status:string){if(!['Not Started','In Progress','On Hold'].includes(status))return fail(409,"Return or reopen this task before changing supporting files.");}
export async function taskFileUpload(db:Db,actor:Actor,request:Request){
 requireTasks(actor);await throttle(db,`task-files:${actor.id}`,12,60000);if(Number(request.headers.get('content-length')??0)>documentLimits.bytes+20000)return fail(413,"Choose a file up to 3 MB.");
 const data=await request.formData(),task=await taskFor(db,actor,str(data.get('id'),"task",80));editable(task.status);
 const file=data.get('file');if(!(file instanceof File)||!file.size||file.size>documentLimits.bytes)return fail(400,"Choose a supported file up to 3 MB.");
 const bytes=Buffer.from(await file.arrayBuffer());
 await scanStaffUpload(db,bytes,actor,file.name);
 const info=await inspectDocument(file.name,bytes),target=id(),key=`walshken/${actor.org_id}/tasks/${taskDataset()}/${task.id}/${target}`,queued=id();
 await run(db,"INSERT INTO task_file_cleanup(id,org_id,storage_key,created_at) VALUES(?,?,?,?)",queued,actor.org_id,key,now());
 const s=await storage(db),client=storageClient(s);try{await client.send(new PutObjectCommand({Bucket:s.bucket,Key:key,Body:bytes,ContentType:info.mime,CacheControl:'private, no-store'}));}finally{client.destroy();}
 try{await db.transaction(async tx=>{
  await one(tx,"SELECT id FROM organizations WHERE id=? FOR UPDATE",actor.org_id);const fresh=await taskFor(tx,actor,task.id,true);editable(fresh.status);
  if(integer(data.get('revision'),"task revision",1,2147483647)!==fresh.revision)return fail(409,"The task changed during upload. Refresh and try again.");
  await run(tx,"INSERT INTO task_files(id,org_id,task_id,uploaded_by,filename,mime,bytes,sha256,storage_key,page_count,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",target,actor.org_id,task.id,actor.id,info.filename,info.mime,bytes.length,info.sha256,key,info.pages,now());
  await run(tx,"DELETE FROM task_file_cleanup WHERE id=?",queued);await run(tx,"UPDATE tasks SET updated_at=?,revision=revision+1 WHERE id=?",now(),task.id);await taskEvent(tx,actor,task.id,"Supporting file uploaded",info.filename);
 });}catch(error){try{await removeObject(db,key);await run(db,"DELETE FROM task_file_cleanup WHERE id=?",queued);}catch{/* Failed cleanup stays queued. */}throw error;}
 return json({ok:true,id:target,message:"Supporting file uploaded privately. Only currently authorized task participants can preview it."},201);
}
type Ticket={employee:string;session:string;task:string;file:string;expires:number};
function key(){const value=process.env.WALSHKEN_INTEGRATION_KEY_V2??process.env.WALSHKEN_INTEGRATION_KEY;if(!value)return fail(503,"Secure preview signing is not configured.");return Buffer.from(value,'base64');}
function readTicket(token:string):Ticket{const[payload,mac,extra]=token.split('.');if(!payload||!mac||extra||token.length>1500)return fail(401,"Reopen this supporting file to refresh access.");const expected=createHmac('sha256',key()).update('task-file:'+payload).digest(),actual=Buffer.from(mac,'base64url');if(expected.length!==actual.length||!timingSafeEqual(expected,actual))return fail(401,"Invalid preview access.");let ticket:Ticket;try{ticket=JSON.parse(Buffer.from(payload,'base64url').toString());}catch{return fail(401,"Invalid preview access.");}if(!Number.isFinite(ticket.expires)||ticket.expires<Date.now()||ticket.expires>Date.now()+121000)return fail(401,"Preview access expired. Reopen the file.");return ticket;}
export async function taskFileAction(db:Db,actor:Actor,action:string,data:Record<string,unknown>,request:Request){
 const task=await taskFor(db,actor,str(data.id,'task',80)),file=await one<TaskFile>(db,'SELECT * FROM task_files WHERE id=? AND task_id=? AND org_id=? AND deleted_at IS NULL',str(data.file,'supporting file',80),task.id,actor.org_id);if(!file)return fail(404,'Supporting file unavailable.');
 if(action==='file-access'){
  const value:Ticket={employee:actor.id,session:await digest(cookieValue(request.headers.get('cookie'))),task:task.id,file:file.id,expires:Date.now()+120000},payload=Buffer.from(JSON.stringify(value)).toString('base64url'),token=payload+'.'+createHmac('sha256',key()).update('task-file:'+payload).digest('base64url');
  await taskEvent(db,actor,task.id,'Supporting file opened',file.filename);return json({ok:true,token,pages:file.page_count,filename:file.filename,expiresAt:value.expires,url:'/api/tasks/file?token='+encodeURIComponent(token)});
 }
 if(action==='file-remove'){
  if(file.uploaded_by!==actor.id&&!canManage(actor))return fail(403,'Only the uploader or an authorized manager may remove a supporting file.');
  await db.transaction(async tx=>{await one(tx,'SELECT id FROM organizations WHERE id=? FOR UPDATE',actor.org_id);const fresh=await taskFor(tx,actor,task.id,true);editable(fresh.status);await run(tx,'UPDATE task_files SET deleted_at=? WHERE id=? AND deleted_at IS NULL',now(),file.id);await run(tx,'INSERT INTO task_file_cleanup(id,org_id,storage_key,created_at) VALUES(?,?,?,?) ON CONFLICT(storage_key) DO NOTHING',id(),actor.org_id,file.storage_key,now());await run(tx,'UPDATE tasks SET revision=revision+1,updated_at=? WHERE id=?',now(),task.id);await taskEvent(tx,actor,task.id,'Supporting file removed',file.filename);});
  try{await removeObject(db,file.storage_key);await run(db,'DELETE FROM task_file_cleanup WHERE storage_key=?',file.storage_key);}catch{/* Revocation is immediate; retry remains durable. */}return json({ok:true,message:'Supporting-file access removed.'});
 }return fail(404,'Supporting-file action unavailable.');
}
export async function taskFileContent(db:Db,actor:Actor,request:Request){
 requireTasks(actor);const params=new URL(request.url).searchParams,ticket=readTicket(params.get('token')??'');if(ticket.employee!==actor.id||ticket.session!==await digest(cookieValue(request.headers.get('cookie'))))return fail(403,'This preview belongs to a different signed-in session.');
 const task=await taskFor(db,actor,ticket.task),file=await one<TaskFile>(db,'SELECT * FROM task_files WHERE id=? AND task_id=? AND org_id=? AND deleted_at IS NULL',ticket.file,task.id,actor.org_id);if(!file)return fail(404,'Supporting file unavailable.');await throttle(db,`task-preview:${actor.id}`,200,60000);
 const s=await storage(db),client=storageClient(s);let bytes:Buffer;try{const result=await client.send(new GetObjectCommand({Bucket:s.bucket,Key:file.storage_key}));if(!result.Body)return fail(404,'Stored content unavailable.');bytes=Buffer.from(await result.Body.transformToByteArray());}finally{client.destroy();}
 if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)return fail(409,'Stored content verification failed.');
 const page=integer(params.get('page')??1,'page',1,file.page_count),image=await renderDocumentPage(file.filename,bytes,page,`${actor.name} · ${actor.employee_no} · ${now().slice(0,16)} UTC`);
 const fresh=await currentActor(db,request);if(!fresh||needsStaffMfa(fresh))return fail(401,'Sign in again to view supporting files.');await taskFor(db,fresh,task.id);
 if(!await one(db,'SELECT id FROM task_files WHERE id=? AND task_id=? AND deleted_at IS NULL',file.id,task.id))return fail(404,'File access was revoked.');
 await taskEvent(db,fresh,task.id,'Supporting file page viewed',`${file.filename}; page ${page}`);
 return new Response(new Uint8Array(image),{headers:{'Content-Type':'image/jpeg','Cache-Control':'private, no-store, max-age=0','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'"}});
}
export async function cleanupTaskFiles(db:Db,actor:Actor){
 requireTasks(actor);if(!canManage(actor))return fail(403,'Manager access required.');const rows=await all<{id:string;storage_key:string}>(db,'SELECT id,storage_key FROM task_file_cleanup WHERE org_id=? AND created_at<? ORDER BY created_at LIMIT 20',actor.org_id,new Date(Date.now()-300000).toISOString());let removed=0,failed=0;
 for(const row of rows){if(!row.storage_key.startsWith(`walshken/${actor.org_id}/tasks/${taskDataset()}/`))continue;if(await one(db,'SELECT id FROM task_files WHERE storage_key=? AND deleted_at IS NULL',row.storage_key))continue;try{await removeObject(db,row.storage_key);await run(db,'DELETE FROM task_file_cleanup WHERE id=?',row.id);removed++;}catch{failed++;}}
 return json({ok:failed===0,removed,failed,message:failed?'Some private objects remain queued for retry.':'Queued storage removal checked.'});
}
