import { createHash } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { accessibleProject, projectLifecycleEnabled } from "./project-authority";
import { openProject, projectNotifications, projectPeople, projectRevision, recordProjectEvent, type AccessibleProject } from "./project-work";
import { taskDataset } from "./tasks";
import { documentStorage } from "./document-storage";
import { inspectDocument } from "./document-render";
import { documentLimits } from "./document-types";
import { storageClient, validateStorage } from "./livekit";
import { scanStaffUpload } from "./staff-delivery";
import { all, audit, currentActor, date, fail, id, json, needsStaffMfa, now, one, pick, requireStaff, run, str, throttle, type Actor, type Db } from "./server";

type Definition = {
  id:string; org_id:string; project_id:string; title:string; due_on:string; assignee_id:string|null; archived_at:string|null;
};
type Version = {
  id:string; deliverable_id:string; version:number; filename:string; mime:string; bytes:number; sha256:string;
  storage_key:string; uploaded_by:string; status:"Submitted"|"Approved"|"Returned";
};

async function getDeliverable(db: Db, actor: Actor, projectId: string, deliverableId: string) {
  const row=await one<Definition>(db,`SELECT * FROM project_deliverables WHERE org_id=? AND project_id=? AND id=? AND archived_at IS NULL`,
    actor.org_id,projectId,deliverableId);
  if(!row)return fail(404,"Project deliverable unavailable.");
  return row;
}

async function latestVersion(db: Db, actor: Actor, entry: Definition) {
  return one<Version>(db,`SELECT * FROM project_deliverable_versions WHERE org_id=? AND deliverable_id=? ORDER BY version DESC LIMIT 1`,
    actor.org_id,entry.id);
}

async function requireUploader(db: Db, actor: Actor, project: AccessibleProject, entry: Definition) {
  openProject(project);
  if(!project.can_manage&&!(entry.assignee_id===actor.id&&(await projectPeople(db,actor.org_id,project.id)).includes(actor.id))) {
    return fail(403,"Only the assigned employee or an authorized manager may submit this deliverable.");
  }
}

async function privateFiles(db: Db) {
  const settings=await documentStorage(db), bucket=process.env.WALSHKEN_TASK_BUCKET;
  if(!bucket||[settings.bucket,"walshken-call-recordings"].includes(bucket))return fail(503,"Configure separate private work-file storage for project deliverables.");
  return validateStorage({...settings,bucket});
}

async function removeFile(db: Db, key: string) {
  const settings=await privateFiles(db), client=storageClient(settings);
  try{await client.send(new DeleteObjectCommand({Bucket:settings.bucket,Key:key}));}
  finally{client.destroy();}
}

export async function projectDeliverableAction(db: Db, actor: Actor, project: AccessibleProject, action: string, data: Record<string,unknown>) {
  openProject(project);
  if(!project.can_manage)return fail(403,"Project management authority is required.");
  if(action==="deliverable-add"||action==="deliverable-edit"){
    const title=str(data.title,"deliverable title",120),description=str(data.description,"instructions",2000,false);
    const due=date(data.due,"deliverable deadline")!,assignee=str(data.assignee,"deliverable assignee",80,false)||null;
    if((project.starts_on&&due<project.starts_on)||(project.due_on&&due>project.due_on))return fail(400,"Choose a date within the project schedule.");
    if(assignee&&!(await projectPeople(db,actor.org_id,project.id)).includes(assignee))return fail(403,"Assign this deliverable to current project staff.");
    const target=action==="deliverable-add"?id():str(data.deliverable,"deliverable",80);
    if(action==="deliverable-add"){
      await run(db,`INSERT INTO project_deliverables(id,org_id,project_id,title,description,due_on,assignee_id,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,target,actor.org_id,project.id,title,description,due,assignee,actor.id,now());
    }else{
      const current=await getDeliverable(db,actor,project.id,target);
      if((await latestVersion(db,actor,current))?.status==="Approved")return fail(409,"An approved deliverable is immutable. Add new work as a separate deliverable.");
      await run(db,"UPDATE project_deliverables SET title=?,description=?,due_on=?,assignee_id=? WHERE org_id=? AND project_id=? AND id=?",
        title,description,due,assignee,actor.org_id,project.id,target);
    }
    if(assignee&&assignee!==actor.id)await projectNotifications(db,actor.org_id,[assignee],"Project deliverable assigned",project.name+" · "+title,project.id);
    await recordProjectEvent(db,actor,project.id,action==="deliverable-add"?"Project deliverable added":"Project deliverable updated");
    return json({ok:true,id:target,message:action==="deliverable-add"?"Deliverable created.":"Deliverable updated."},action==="deliverable-add"?201:200);
  }

  const entry=await getDeliverable(db,actor,project.id,str(data.deliverable,"deliverable",80));
  const current=await latestVersion(db,actor,entry);
  if(action==="deliverable-archive"){
    if(current&&current.status!=="Returned")return fail(409,"Only unsubmitted or returned deliverables may be archived.");
    await run(db,"UPDATE project_deliverables SET archived_at=? WHERE org_id=? AND id=?",now(),actor.org_id,entry.id);
    await recordProjectEvent(db,actor,project.id,"Project deliverable archived");
    return json({ok:true,message:"Deliverable archived."});
  }
  if(action!=="deliverable-review")return fail(404,"Project action unavailable.");
  if(!current||current.status!=="Submitted")return fail(409,"No submitted deliverable is waiting for review.");
  if(current.uploaded_by===actor.id)return fail(403,"A different project manager must review your submission.");
  if(str(data.version,"submission version",80)!==current.id)return fail(409,"This submission has changed. Refresh.");
  const decision=pick(data.decision,["Approved","Returned"] as const,"review decision");
  const reason=str(data.reason,"review note",500);
  await run(db,`UPDATE project_deliverable_versions SET status=?,reviewed_by=?,reviewed_at=?,review_note=?
    WHERE org_id=? AND deliverable_id=? AND id=? AND status='Submitted'`,decision,actor.id,now(),reason,actor.org_id,entry.id,current.id);
  await projectNotifications(db,actor.org_id,[current.uploaded_by],"Project deliverable "+decision.toLowerCase(),project.name+" · "+entry.title,project.id);
  await recordProjectEvent(db,actor,project.id,"Project deliverable "+decision.toLowerCase());
  return json({ok:true,message:"Review decision recorded."});
}

export async function uploadProjectDeliverable(db: Db, actor: Actor, request: Request) {
  if(!projectLifecycleEnabled())return fail(404,"Project deliverables are unavailable.");
  requireStaff(actor);
  await throttle(db,"project-upload:"+actor.id,10,60_000);
  if(Number(request.headers.get("content-length")??0)>documentLimits.bytes+20_000)return fail(413,"Choose a file up to 3 MB.");
  const fields=await request.formData();
  const projectId=str(fields.get("project"),"project",80),target=str(fields.get("deliverable"),"deliverable",80);
  const project=await accessibleProject(db,actor,projectId,taskDataset());
  const entry=await getDeliverable(db,actor,projectId,target);
  await requireUploader(db,actor,project,entry);
  projectRevision(project,fields.get("revision"));
  const existing=await latestVersion(db,actor,entry);
  if(existing&&existing.status!=="Returned")return fail(409,"Only returned work can be resubmitted. Wait for independent review.");
  const file=fields.get("file");
  if(!(file instanceof File)||!file.size||file.size>documentLimits.bytes)return fail(400,"Choose a supported file up to 3 MB.");
  const bytes=Buffer.from(await file.arrayBuffer());
  const info=await inspectDocument(file.name,bytes);
  await scanStaffUpload(db,bytes,actor,file.name);
  const settings=await privateFiles(db);
  const version=id(),cleanup=id();
  const objectKey=`walshken/${actor.org_id}/project-deliverables/${taskDataset()}/${projectId}/${version}`;
  await run(db,"INSERT INTO task_file_cleanup(id,org_id,storage_key,created_at) VALUES(?,?,?,?)",cleanup,actor.org_id,objectKey,now());
  const client=storageClient(settings);
  try{
    await client.send(new PutObjectCommand({Bucket:settings.bucket,Key:objectKey,Body:bytes,ContentType:info.mime,CacheControl:"private, no-store"}));
    await db.transaction(async tx=>{
      await one(tx,"SELECT id FROM organizations WHERE id=? FOR UPDATE",actor.org_id);
      const active=await currentActor(tx,request);
      if(!active||active.id!==actor.id||needsStaffMfa(active))return fail(401,"Sign in again before submitting this deliverable.");
      const fresh=await accessibleProject(tx,active,projectId,taskDataset(),true);
      const work=await getDeliverable(tx,active,projectId,target);
      await requireUploader(tx,active,fresh,work);
      projectRevision(fresh,fields.get("revision"));
      const latest=await latestVersion(tx,actor,work);
      if(latest&&latest.status!=="Returned")return fail(409,"Someone has already submitted this deliverable.");
      await run(tx,`INSERT INTO project_deliverable_versions(id,org_id,deliverable_id,version,uploaded_by,created_at,filename,mime,bytes,sha256,storage_key)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,version,actor.org_id,target,(latest?.version??0)+1,actor.id,now(),info.filename,info.mime,bytes.length,info.sha256,objectKey);
      await run(tx,"DELETE FROM task_file_cleanup WHERE id=? AND org_id=?",cleanup,actor.org_id);
      await projectNotifications(tx,actor.org_id,[fresh.owner_id,...(fresh.manager_id?[fresh.manager_id]:[])].filter(employee=>employee!==actor.id),
        "Project deliverable submitted",fresh.name+" · "+work.title,projectId);
      await recordProjectEvent(tx,actor,projectId,"Project deliverable submitted");
    });
  }catch(error){
    try{
      const committed=await one(db,"SELECT id FROM project_deliverable_versions WHERE id=? AND org_id=? AND storage_key=?",version,actor.org_id,objectKey);
      if(committed)return json({ok:true,id:version,message:"Deliverable uploaded privately and submitted for review."},201);
      await removeFile(db,objectKey);
      await run(db,"DELETE FROM task_file_cleanup WHERE id=? AND org_id=?",cleanup,actor.org_id);
    }catch{/* The scheduled cleanup owns this orphan. */}
    throw error;
  }finally{client.destroy();}
  return json({ok:true,id:version,message:"Deliverable uploaded privately and submitted for review."},201);
}

export async function downloadProjectDeliverable(db: Db, actor: Actor, request: Request) {
  if(!projectLifecycleEnabled())return fail(404,"Project deliverables are unavailable.");
  requireStaff(actor);
  await throttle(db,"project-download:"+actor.id,90,60_000);
  const params=new URL(request.url).searchParams;
  const projectId=str(params.get("project"),"project",80),target=str(params.get("deliverable"),"deliverable",80);
  const project=await accessibleProject(db,actor,projectId,taskDataset());
  const entry=await getDeliverable(db,actor,projectId,target);
  const version=await one<Version>(db,"SELECT * FROM project_deliverable_versions WHERE org_id=? AND deliverable_id=? AND id=?",
    actor.org_id,target,str(params.get("version"),"submission version",80));
  if(!version)return fail(404,"Project file unavailable.");
  if(!project.can_manage&&version.uploaded_by!==actor.id
       &&entry.assignee_id!==actor.id&&project.owner_id!==actor.id) {
    return fail(403,"This project file is available only to its assigned staff and authorized managers.");
  }
  const settings=await privateFiles(db), client=storageClient(settings);
  let bytes:Buffer;
  try{
    const result=await client.send(new GetObjectCommand({Bucket:settings.bucket,Key:version.storage_key}));
    if(!result.Body)return fail(404,"Stored content unavailable.");
    bytes=Buffer.from(await result.Body.transformToByteArray());
  }finally{client.destroy();}
  if(bytes.length!==version.bytes||createHash("sha256").update(bytes).digest("hex")!==version.sha256)return fail(409,"Stored content verification failed.");
  const active=await currentActor(db,request);
  if(!active||needsStaffMfa(active))return fail(401,"Sign in again to download this deliverable.");
  const current=await accessibleProject(db,active,projectId,taskDataset());
  const currentEntry=await getDeliverable(db,active,projectId,target);
  if(!current.can_manage&&active.id!==version.uploaded_by&&current.owner_id!==active.id&&currentEntry.assignee_id!==active.id){
    return fail(403,"Project file access changed.");
  }
  await audit(db,active,"Project deliverable downloaded","project",projectId).run();
  return new Response(new Uint8Array(bytes),{headers:{
    "Content-Type":version.mime,"Content-Disposition":`attachment; filename="project-deliverable"; filename*=UTF-8''${encodeURIComponent(version.filename).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16))}`,
    "Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"sandbox; default-src 'none'",
    "Cross-Origin-Resource-Policy":"same-origin","Referrer-Policy":"no-referrer",
  }});
}

export async function cleanupProjectDeliverables(db: Db) {
  if(!projectLifecycleEnabled())return 0;
  const rows=await all<{id:string;org_id:string;storage_key:string}>(db,`SELECT id,org_id,storage_key FROM task_file_cleanup
    WHERE storage_key LIKE 'walshken/%/project-deliverables/'||?||'/%' AND created_at<? ORDER BY created_at LIMIT 20`,
    taskDataset(),new Date(Date.now()-300_000).toISOString());
  const expires=performance.now()+2000;
  let cleaned=0;
  for(const row of rows){
    if(performance.now()>=expires)break;
    if(!row.storage_key.startsWith(`walshken/${row.org_id}/project-deliverables/${taskDataset()}/`))continue;
    if(await one(db,"SELECT id FROM project_deliverable_versions WHERE org_id=? AND storage_key=?",row.org_id,row.storage_key))continue;
    try{
      await removeFile(db,row.storage_key);
      await run(db,"DELETE FROM task_file_cleanup WHERE id=? AND org_id=?",row.id,row.org_id);
      cleaned++;
    }catch{/* Retry on the next run. */}
  }
  return cleaned;
}
