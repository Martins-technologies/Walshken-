import {assertNoLegalHold,assertRecordRetention} from "./retention";
import {scanStaffUpload} from "./staff-delivery";
import { createHash,createHmac,timingSafeEqual } from "node:crypto";
import { all, cookieValue, currentActor, digest, fail, id, integer, json, needsStaffMfa, notify, now, one, pick, run, str, throttle, type Actor,type Db } from "./server";
import { roles } from "./catalog";
import { allowedDocumentActions, documentAdministrator, documentContext, documentEvaluation, documentEvent, documentGroups, documentLock, documentMask, requireDocumentPermission, requireDocuments, type AccessContext } from "./document-access";
import { allDocumentPermissions, documentCategories, documentLimits, documentPermissions, documentSafetyNotice, permissionBit, type DocumentEntry, type DocumentPermission, type DocumentRule, type DocumentVersion, type FolderEntry } from "./document-types";
import { inspectDocument,renderDocumentPage } from "./document-render";
import { deleteDocumentObject,getDocumentObject,putDocumentObject } from "./document-storage";

const isAdmin=documentAdministrator;
type Input=Record<string,unknown>;
export async function documentList(db:Db,actor:Actor){
 requireDocuments();
 const [allEntries,allFolders,staff,departments,groups,rootMask]=await Promise.all([
  all<DocumentEntry & {owner:string;bytes:number;mime:string;version:number;pages:number}>(db,`SELECT d.*,e.name AS owner,v.bytes,v.mime,v.version,v.page_count AS pages FROM doc_entries d JOIN employees e ON e.id=d.owner_id LEFT JOIN doc_versions v ON v.id=d.current_version WHERE d.org_id=? ORDER BY d.updated_at DESC`,actor.org_id),
  all<FolderEntry>(db,"SELECT * FROM doc_folders WHERE org_id=? ORDER BY name",actor.org_id),
  all(db,"SELECT id,name,email,role,department_id FROM employees WHERE org_id=? AND status='Active' AND employment_status<>'Ended' ORDER BY name",actor.org_id),
  all(db,"SELECT id,name FROM units WHERE org_id=? AND kind='Department' ORDER BY name",actor.org_id),isAdmin(actor)?all<{id:string;title:string}>(db,"SELECT id,title FROM conversations WHERE org_id=? AND status='Active' AND kind<>'Direct' AND (closes_at IS NULL OR closes_at>?) ORDER BY title",actor.org_id,now()):documentGroups(db,actor),
  documentMask(db,actor,await documentContext(db,actor)),
 ]);
 const evaluation=await documentEvaluation(db,actor),folderMap=new Map(allFolders.map(f=>[f.id,f]));
 const cachedContext=(entry?:DocumentEntry,folderId?:string):AccessContext=>{const folders:FolderEntry[]=[];let next=entry?.folder_id??folderId;const seen=new Set<string>();while(next){const value=folderMap.get(next);if(!value||value.revoked_at||seen.has(next)||seen.size>=30)return fail(404,"Folder unavailable.");seen.add(next);folders.push(value);next=value.parent_id??undefined;}return {document:entry,folders,department:entry?.department_id??folders.find(f=>f.department_id)?.department_id??null,group:entry?.group_id??folders.find(f=>f.group_id)?.group_id??null};};
 const rows=[];for(const entry of allEntries){
  if((entry.deleted_at||entry.revoked_at)&&isAdmin(actor)){rows.push({...entry,permissions:[],status:entry.deleted_at?"Deleted":"Revoked"});continue;}
  if(entry.deleted_at||entry.revoked_at)continue;
  try{const mask=await documentMask(db,actor,cachedContext(entry),0,evaluation);if(mask&permissionBit("view"))rows.push({...entry,permissions:allowedDocumentActions(mask),status:"Active"});}catch{/* An inaccessible ancestor hides its files. */}
 }
 const folders=[];for(const folder of allFolders){
  if(folder.revoked_at){if(isAdmin(actor))folders.push({...folder,permissions:[]});continue;}
  try{const mask=await documentMask(db,actor,cachedContext(undefined,folder.id),0,evaluation);if(mask||isAdmin(actor))folders.push({...folder,permissions:allowedDocumentActions(mask)});}catch{/* Parent was revoked. */}
 }
 // Recipient choices are identifiers only. Every action applies its own fresh authorization.
 return json({managedDocuments:true,rows,folders,staff:actor.role==="guest"?[]:staff,departments:actor.role==="guest"?[]:departments,groups,
  rootPermissions:allowedDocumentActions(rootMask),administrator:isAdmin(actor),notice:documentSafetyNotice,limits:documentLimits,
  rules:isAdmin(actor)?await all(db,"SELECT a.*,e.name AS creator FROM doc_acl a JOIN employees e ON e.id=a.created_by WHERE a.org_id=? ORDER BY a.created_at DESC",actor.org_id):[]});
}
async function targetContext(db:Db,actor:Actor,data:Input){
 const scope=pick(data.scope,["organization","department","group","folder","document"] as const,"permission level");
 const target=scope==="organization"?actor.org_id:str(data.target,"permission target",80);
 let context:AccessContext;
 if(scope==="document")context=await documentContext(db,actor,target);
 else if(scope==="folder")context=await documentContext(db,actor,undefined,target);
 else{
  if(scope==="department"&&!await one(db,"SELECT id FROM units WHERE id=? AND org_id=? AND kind='Department'",target,actor.org_id))return fail(404,"Department unavailable.");
  if(scope==="group"&&!await one(db,"SELECT id FROM conversations WHERE id=? AND org_id=? AND kind<>'Direct' AND status='Active'",target,actor.org_id))return fail(404,"Group unavailable.");
  context={folders:[],department:scope==="department"?target:null,group:scope==="group"?target:null};
 }
 if(["organization","department","group"].includes(scope)&&!isAdmin(actor))return fail(403,"Only a Super Admin can change organization, department or group policies.");
 await requireDocumentPermission(db,actor,context,"manage");return {scope,target,context};
}
async function validatePrincipal(db:Db,actor:Actor,type:string,target:string){
 if(type==="all")return "staff";
 if(type==="role"){pick(target,roles,"staff role");if(target==="guest")return fail(400,"Guest access must be granted to individual guest accounts.");return target;}
 const query=type==="employee"?"SELECT id FROM employees WHERE id=? AND org_id=? AND status='Active' AND employment_status<>'Ended'":type==="department"?"SELECT id FROM units WHERE id=? AND org_id=? AND kind='Department'":"SELECT id FROM conversations WHERE id=? AND org_id=? AND status='Active' AND kind<>'Direct'";
 if(!await one(db,query,target,actor.org_id))return fail(404,"Permission recipient unavailable.");return target;
}
async function appendRule(db:Db,actor:Actor,scope:string,target:string,principalType:string,principalId:string,effect:string,mask:number,expires:string|null,sourceActor:string|null=null){
 await run(db,`INSERT INTO doc_acl(id,org_id,scope_type,scope_id,principal_type,principal_id,effect,mask,expires_at,created_by,source_document,source_actor,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,id(),actor.org_id,scope,target,principalType,principalId,effect,mask,expires,actor.id,sourceActor?target:null,sourceActor,now());
}
const expiresAt=(value:unknown)=>{if(!value)return null;const valueString=str(value,"expiry",40),date=new Date(valueString);if(!Number.isFinite(date.getTime())||date.getTime()<=Date.now()||date.getTime()>Date.now()+366*86400_000)return fail(400,"Choose an expiry within the next year.");return date.toISOString();};
export async function documentAction(db:Db,actor:Actor,action:string,data:Input,request:Request){
 requireDocuments();await throttle(db,`documents:${actor.id}`,100,60_000);
 if(action==="access"){
  const target=str(data.id,"document",80),context=await documentContext(db,actor,target),purpose=pick(data.purpose,["view","download","print"] as const,"access purpose");
  const mask=await requireDocumentPermission(db,actor,context,purpose),entry=context.document!;
  const versionId=str(data.version??entry.current_version,"version",80),version=await one<DocumentVersion>(db,"SELECT * FROM doc_versions WHERE id=? AND document_id=? AND org_id=?",versionId,target,actor.org_id);
  if(!version)return fail(404,"Version unavailable.");
  const token=await issueDocumentToken(request,actor,version,purpose);
  await documentEvent(db,actor,"Opened",target,`${purpose} access issued`,null,version.id);
  return json({ok:true,token,expiresAt:Date.now()+120_000,pages:version.page_count,name:entry.name,filename:version.filename,version:version.version,
   permissions:allowedDocumentActions(mask),watermark:!!entry.watermark,url:`/api/documents/content?token=${encodeURIComponent(token)}`});
 }
 if(action==="detail"){
  const context=await documentContext(db,actor,str(data.id,"document",80)),mask=await requireDocumentPermission(db,actor,context,"view"),entry=context.document!;
  const manager=!!(mask&permissionBit("manage"));
  return json({row:entry,permissions:allowedDocumentActions(mask),versions:await all(db,"SELECT id,version,filename,mime,bytes,page_count,created_at,note,created_by FROM doc_versions WHERE document_id=? AND org_id=? ORDER BY version DESC",entry.id,actor.org_id),
   rules:manager?await all(db,"SELECT a.*,e.name AS creator FROM doc_acl a JOIN employees e ON e.id=a.created_by WHERE a.org_id=? AND a.scope_type='document' AND a.scope_id=? ORDER BY a.created_at DESC",actor.org_id,entry.id):[],
   events:manager?await documentEvents(db,actor,entry.id):[]});
 }
 if(action==="audit"){
  const documentId=str(data.id,"document",80,false);if(!isAdmin(actor)){if(!documentId)return fail(403,"Administrator access required.");await requireDocumentPermission(db,actor,await documentContext(db,actor,documentId),"manage");}
  return json({rows:await documentEvents(db,actor,documentId,Number(data.page)||1)});
 }
 if(action==="cleanup"){
  if(!isAdmin(actor))return fail(403,"Administrator access required.");return json(await cleanupDocumentObjects(db,actor));
 }
 return db.transaction(async tx=>{
  await documentLock(tx,actor);
  if(action==="rule-add"){
   const {scope,target,context}=await targetContext(tx,actor,data),principalType=pick(data.principalType,["all","employee","role","department","group"] as const,"recipient type"),principalId=await validatePrincipal(tx,actor,principalType,str(data.principalId,"recipient",80,false));
   const effect=pick(data.effect,["allow","deny"] as const,"permission effect");
   if(!Array.isArray(data.permissions)||!data.permissions.length)return fail(400,"Choose at least one permission.");
   const mask=data.permissions.reduce<number>((mask,permission)=>mask|permissionBit(pick(permission,documentPermissions,"permission")),0);
   const own=await documentMask(tx,actor,context);if(!isAdmin(actor)&&(mask&own)!==mask)return fail(403,"You may grant or deny only permissions you currently hold.");
   const guest=principalType==="employee"?await one<{role:string}>(tx,"SELECT role FROM employees WHERE id=?",principalId):null;
   if(guest?.role==="guest"&&effect==="allow"&&(scope!=="document"||!(own&permissionBit("external"))||mask&~(permissionBit("view")|permissionBit("download")|permissionBit("print"))))return fail(403,"Guest access requires document-level external sharing permission and view, download or print rights only.");
   await appendRule(tx,actor,scope,target,principalType,principalId,effect,mask,expiresAt(data.expiresAt));
   await documentEvent(tx,actor,"Permissions changed",scope==="document"?target:null,`${scope}:${target}; ${effect} ${allowedDocumentActions(mask).join(", ")} to ${principalType}:${principalId}`,principalType==="employee"?principalId:null,null,scope==="folder"?target:null);
   return json({ok:true,message:"Permission rule saved. Current access is rechecked immediately."});
  }
  if(action==="rule-remove"){
   const rule=await one<DocumentRule>(tx,"SELECT * FROM doc_acl WHERE id=? AND org_id=?",str(data.rule,"permission rule",80),actor.org_id);if(!rule)return fail(404,"Permission rule unavailable.");
   await targetContext(tx,actor,{scope:rule.scope_type,target:rule.scope_id});
   if(rule.effect==="deny"&&!isAdmin(actor))return fail(403,"Only a Super Admin may remove explicit denial rules.");
   await run(tx,"DELETE FROM doc_acl WHERE id=? AND org_id=?",rule.id,actor.org_id);await documentEvent(tx,actor,"Permission revoked",rule.scope_type==="document"?rule.scope_id:null,`${rule.scope_type}:${rule.scope_id}; rule ${rule.id}`,rule.principal_type==="employee"?rule.principal_id:null);
   return json({ok:true,message:"Permission rule removed."});
  }
  if(action==="folder-add"){
   if(!isAdmin(actor))return fail(403,"Only a Super Admin can create organizational folders.");
   const parent=str(data.parent,"parent folder",80,false);if(parent)await documentContext(tx,actor,undefined,parent);
   const department=str(data.department,"department",80,false),group=str(data.group,"group",80,false);await validateClassification(tx,actor,department,group);
   const target=id();await run(tx,"INSERT INTO doc_folders(id,org_id,parent_id,name,department_id,group_id,created_by) VALUES(?,?,?,?,?,?,?)",target,actor.org_id,parent||null,str(data.name,"folder name",100),department||null,group||null,actor.id);
   await documentEvent(tx,actor,"Folder created",null,str(data.name,"folder name",100),null,null,target);return json({ok:true,id:target,message:"Folder created."},201);
  }
  if(action==="folder-update"){
   const folder=str(data.id,"folder",80),entry=await one<FolderEntry>(tx,"SELECT * FROM doc_folders WHERE id=? AND org_id=?",folder,actor.org_id);if(!entry)return fail(404,"Folder unavailable.");
   if(!isAdmin(actor))await requireDocumentPermission(tx,actor,await documentContext(tx,actor,undefined,folder),"manage");
   if(data.restore&&!isAdmin(actor))return fail(403,"Only a Super Admin can restore revoked folders.");
   await run(tx,"UPDATE doc_folders SET name=?,revoked_at=? WHERE id=? AND org_id=?",str(data.name??entry.name,"folder name",100),data.revoke?now():data.restore?null:entry.revoked_at,folder,actor.org_id);
   await documentEvent(tx,actor,data.revoke?"Folder access revoked":data.restore?"Folder restored":"Folder renamed",null,entry.name,null,null,folder);return json({ok:true,message:"Folder updated."});
  }
  const target=str(data.id,"document",80);
  if(action==="restore"){
   if(!isAdmin(actor))return fail(403,"Only a Super Admin can restore access.");const entry=await one<DocumentEntry>(tx,"SELECT * FROM doc_entries WHERE id=? AND org_id=?",target,actor.org_id);
   if(!entry||entry.deleted_at)return fail(404,"Deleted files cannot be restored.");await run(tx,"UPDATE doc_entries SET revoked_at=NULL,updated_at=? WHERE id=?",now(),target);await documentEvent(tx,actor,"Access restored",target);return json({ok:true,message:"Document access restored."});
  }
  const context=await documentContext(tx,actor,target),entry=context.document!;
  if(action==="metadata"){
   await requireDocumentPermission(tx,actor,context,"edit");
   if(String(data.expectedVersion)!==entry.current_version)return fail(409,"The document changed. Reload before editing.");
   const folder=str(data.folder??entry.folder_id,"folder",80,false);
   if(folder!==(entry.folder_id??"")){await requireDocumentPermission(tx,actor,context,"manage");await requireDocumentPermission(tx,actor,await documentContext(tx,actor,undefined,folder||undefined),"upload");}
   const watermark=data.watermark===undefined?entry.watermark:(data.watermark===true||data.watermark==="1")?1:0;
   if(watermark!==entry.watermark)await requireDocumentPermission(tx,actor,context,"manage");
   await run(tx,"UPDATE doc_entries SET name=?,description=?,category=?,folder_id=?,watermark=?,updated_at=? WHERE id=? AND org_id=?",str(data.name,"document name",150),str(data.description,"description",1000,false),pick(data.category,documentCategories,"document category"),folder||null,watermark,now(),target,actor.org_id);
   await documentEvent(tx,actor,"Modified",target,"Document details updated");return json({ok:true,message:"Document details saved."});
  }
  if(action==="forward"||action==="external"){
   const permission=action==="external"?"external":"forward";await requireDocumentPermission(tx,actor,context,permission);
   if(actor.role==="guest")return fail(403,"External recipients cannot forward files.");
   const recipient=await one<Actor>(tx,"SELECT * FROM employees WHERE id=? AND org_id=? AND status='Active' AND employment_status<>'Ended'",str(data.recipient,"recipient",80),actor.org_id);
   if(!recipient||recipient.id===actor.id)return fail(400,"Choose another active recipient.");
   if((action==="external")!==(recipient.role==="guest"))return fail(403,"Use internal forwarding for staff and authorized external sharing for guest accounts.");
   // An explicit individual deny always wins over forwarded access.
   const denied=await all<DocumentRule>(tx,"SELECT * FROM doc_acl WHERE org_id=? AND scope_type='document' AND scope_id=? AND principal_type='employee' AND principal_id=? AND effect='deny' AND (expires_at IS NULL OR expires_at>?)",actor.org_id,target,recipient.id,now());
   if(denied.some(rule=>rule.mask&permissionBit("view")))return fail(403,"The recipient's document access is explicitly denied.");
   await appendRule(tx,actor,"document",target,"employee",recipient.id,"allow",permissionBit("view"),expiresAt(data.expiresAt),actor.id);
   // Verify after the prospective grant. Failure rolls it back without revealing content.
   await requireDocumentPermission(tx,recipient,context,"view");
   await documentEvent(tx,actor,action==="external"?"Shared externally":"Forwarded internally",target,"View only; original download and print not granted",recipient.id);
   await notify(tx,recipient.id,"Document shared",`${actor.name} shared a private document with you.`,`/staff/documents?document=${target}`).run();
   return json({ok:true,url:`/staff/documents?document=${encodeURIComponent(target)}`,message:action==="external"?"Shared with the signed-in guest account. The link requires its own login and MFA.":"Forwarded to the authorized staff account with view-only access."});
  }
  if(action==="revoke"||action==="delete"){
   await requireDocumentPermission(tx,actor,context,action==="delete"?"delete":"manage");
   if(action==="delete")await assertNoLegalHold(tx,actor.org_id,"document",target,context.document?.owner_id);
   if(action==='delete'){
    const owner=await one<{country:string}>(tx,'SELECT country FROM employees WHERE org_id=? AND id=?',actor.org_id,context.document?.owner_id);
    await assertRecordRetention(tx,actor.org_id,owner?.country??'', 'Documents',context.document!.created_at);
   }
   await run(tx,`UPDATE doc_entries SET ${action==="delete"?"deleted_at":"revoked_at"}=?,updated_at=? WHERE id=? AND org_id=?`,now(),now(),target,actor.org_id);
   if(action==="delete")await run(tx,"INSERT INTO doc_object_cleanup(id,org_id,storage_key,created_at) SELECT id,org_id,storage_key,? FROM doc_versions WHERE document_id=? AND org_id=? ON CONFLICT(storage_key) DO NOTHING",now(),target,actor.org_id);
   await documentEvent(tx,actor,action==="delete"?"Deleted":"Access revoked",target);return json({ok:true,message:action==="delete"?"Document deleted. Its content is unavailable and storage removal is queued.":"Document access revoked immediately."});
  }
  return fail(404,"Document action unavailable.");
 });
}
async function validateClassification(db:Db,actor:Actor,department:string,group:string){
 if(department&&!await one(db,"SELECT id FROM units WHERE id=? AND org_id=? AND kind='Department'",department,actor.org_id))return fail(404,"Department unavailable.");
 if(group&&!await one(db,"SELECT id FROM conversations WHERE id=? AND org_id=? AND status='Active' AND kind<>'Direct'",group,actor.org_id))return fail(404,"Group unavailable.");
}
export async function uploadManagedDocument(db:Db,actor:Actor,request:Request){
 requireDocuments();if(actor.role==="guest")return fail(403,"External recipients cannot upload files.");await throttle(db,`document-upload:${actor.id}`,12,60_000);
 if(Number(request.headers.get("content-length")??0)>documentLimits.bytes+20000)return fail(413,"Choose a file up to 3 MB.");
 const data=await request.formData(),file=data.get("file");if(!(file instanceof File)||file.size>documentLimits.bytes)return fail(400,"Choose a supported file up to 3 MB.");
 const documentId=str(data.get("id"),"document",80,false),folderId=str(data.get("folder"),"folder",80,false);
 const context=await documentContext(db,actor,documentId||undefined,folderId||undefined);await requireDocumentPermission(db,actor,context,documentId?"edit":"upload");
 const bytes=Buffer.from(await file.arrayBuffer());
 await scanStaffUpload(db,bytes,actor,file.name);
 const inspected=await inspectDocument(file.name,bytes),target=documentId||id(),versionId=id(),key=`walshken/${actor.org_id}/documents/${target}/${versionId}`;
 // Queue first so a failed storage write or transaction leaves a recoverable cleanup record.
 const cleanupId=id();await run(db,"INSERT INTO doc_object_cleanup(id,org_id,storage_key,created_at) VALUES(?,?,?,?)",cleanupId,actor.org_id,key,now());
 await putDocumentObject(db,key,bytes,inspected.mime);
 try{
  await db.transaction(async tx=>{
   await documentLock(tx,actor,target);
   const fresh=await documentContext(tx,actor,documentId||undefined,folderId||undefined);await requireDocumentPermission(tx,actor,fresh,documentId?"edit":"upload");
   if(documentId&&str(data.get("expectedVersion"),"expected version",80)!==fresh.document!.current_version)return fail(409,"A newer version was saved. Reload before replacing the file.");
   const currentTime=now();
   if(!documentId){
    await run(tx,"INSERT INTO doc_entries(id,org_id,folder_id,owner_id,name,description,category,watermark,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",target,actor.org_id,folderId||null,actor.id,str(data.get("name")||inspected.filename,"document name",150),str(data.get("description"),"description",1000,false),pick(data.get("category")||"General document",documentCategories,"category"),isAdmin(actor)&&data.get("watermark")==="1"?1:0,currentTime,currentTime);
    await appendRule(tx,actor,"document",target,"employee",actor.id,"allow",permissionBit("view")|permissionBit("edit"),null);
   }
   const version=(await one<{version:number}>(tx,"SELECT COALESCE(MAX(version),0)+1 AS version FROM doc_versions WHERE document_id=?",target))!.version;
   await run(tx,"INSERT INTO doc_versions(id,org_id,document_id,version,filename,mime,bytes,sha256,storage_key,page_count,created_by,created_at,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",versionId,actor.org_id,target,version,inspected.filename,inspected.mime,bytes.length,inspected.sha256,key,inspected.pages,actor.id,currentTime,str(data.get("note"),"version note",500,false));
   await run(tx,"UPDATE doc_entries SET current_version=?,updated_at=? WHERE id=? AND org_id=?",versionId,currentTime,target,actor.org_id);
   await run(tx,"DELETE FROM doc_object_cleanup WHERE id=?",cleanupId);
   await documentEvent(tx,actor,documentId?"Version uploaded":"Uploaded",target,`Version ${version}; ${inspected.filename}; ${bytes.length} bytes`,null,versionId);
  });
 }catch(error){try{await deleteDocumentObject(db,key);await run(db,"DELETE FROM doc_object_cleanup WHERE id=?",cleanupId);}catch{/* Durable cleanup queue retains this key. */}throw error;}
 return json({ok:true,id:target,message:documentId?"New version saved. Previous versions remain available to authorized users.":"Document uploaded privately."},201);
}
export async function cleanupDocumentObjects(db:Db,actor:Actor){
 const rows=await all<{id:string;storage_key:string}>(db,"SELECT q.id,q.storage_key FROM doc_object_cleanup q WHERE q.org_id=? AND (q.created_at<? OR EXISTS(SELECT 1 FROM doc_versions v JOIN doc_entries d ON d.id=v.document_id WHERE v.storage_key=q.storage_key AND d.deleted_at IS NOT NULL)) ORDER BY q.created_at LIMIT 20",actor.org_id,new Date(Date.now()-300000).toISOString());
 let deleted=0,failed=0;for(const row of rows){
  // Never remove a current or historical object for a non-deleted file, even if an upload crashed late.
  if(await one(db,"SELECT v.id FROM doc_versions v JOIN doc_entries d ON d.id=v.document_id WHERE v.storage_key=? AND d.deleted_at IS NULL",row.storage_key))continue;
  try{
   const file=await one<{id:string;owner_id:string}>(db,'SELECT d.id,d.owner_id FROM doc_versions v JOIN doc_entries d ON d.id=v.document_id WHERE v.storage_key=?',row.storage_key);
   await assertNoLegalHold(db,actor.org_id,'document',file?.id??'',file?.owner_id);
   await deleteDocumentObject(db,row.storage_key);await run(db,"DELETE FROM doc_object_cleanup WHERE id=? AND org_id=?",row.id,actor.org_id);deleted++;}catch{failed++;}
 }return {ok:failed===0,deleted,failed};
}
async function documentEvents(db:Db,actor:Actor,target="",page=1){
 return all(db,`SELECT a.id,a.document_id,a.folder_id,a.action,a.detail,a.created_at,a.version_id,e.name AS actor,e.employee_no,r.name AS recipient,d.name AS document
 FROM doc_events a JOIN employees e ON e.id=a.actor_id LEFT JOIN employees r ON r.id=a.recipient_id LEFT JOIN doc_entries d ON d.id=a.document_id
 WHERE a.org_id=? AND (?='' OR a.document_id=?) ORDER BY a.created_at DESC,a.id DESC LIMIT 101 OFFSET ?`,actor.org_id,target,target,(Math.max(1,Math.min(10000,page))-1)*100);
}
type AccessToken={employee:string;session:string;document:string;version:string;purpose:"view"|"download"|"print";expires:number};
function signingKey(){const key=process.env.WALSHKEN_INTEGRATION_KEY_V2??process.env.WALSHKEN_INTEGRATION_KEY;if(!key)return fail(503,"Secure document access is awaiting server configuration.");return Buffer.from(key,"base64");}
async function issueDocumentToken(request:Request,actor:Actor,version:DocumentVersion,purpose:AccessToken["purpose"]){
 const data:AccessToken={employee:actor.id,session:await digest(cookieValue(request.headers.get("cookie"))),document:version.document_id,version:version.id,purpose,expires:Date.now()+120000};
 const payload=Buffer.from(JSON.stringify(data)).toString("base64url");return payload+"."+createHmac("sha256",signingKey()).update("document-access:"+payload).digest("base64url");
}
function parseToken(raw:string):AccessToken{
 const [payload,mac,extra]=raw.split(".");if(!payload||!mac||extra||raw.length>1500)return fail(401,"Document access has expired. Reopen the file.");
 const expected=createHmac("sha256",signingKey()).update("document-access:"+payload).digest(),actual=Buffer.from(mac,"base64url");
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return fail(401,"Document access has expired. Reopen the file.");
 let value:AccessToken;try{value=JSON.parse(Buffer.from(payload,"base64url").toString());}catch{return fail(401,"Invalid document access.");}
 if(value.expires<=Date.now()||!Number.isFinite(value.expires)||value.expires>Date.now()+121000||!["view","download","print"].includes(value.purpose))return fail(401,"Document access has expired. Reopen the file.");return value;
}
export async function documentContent(db:Db,actor:Actor,request:Request){
 requireDocuments();const params=new URL(request.url).searchParams,token=parseToken(params.get("token")??"");
 if(token.employee!==actor.id||token.session!==await digest(cookieValue(request.headers.get("cookie"))))return fail(403,"This access link belongs to a different signed-in session.");
 await throttle(db,`document-open:${actor.id}`,300,60000);
 const context=await documentContext(db,actor,token.document);await requireDocumentPermission(db,actor,context,token.purpose);
 const version=await one<DocumentVersion>(db,"SELECT * FROM doc_versions WHERE id=? AND document_id=? AND org_id=?",token.version,token.document,actor.org_id);if(!version)return fail(404,"File version unavailable.");
 const headers={"Cache-Control":"private, no-store, max-age=0","Pragma":"no-cache","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","Cross-Origin-Resource-Policy":"same-origin"};
 if(token.purpose==="print"&&!params.has("page")){
  await documentEvent(db,actor,"Printed",token.document,"Authorized print representation opened",null,version.id);
  const url=`/api/documents/content?token=${encodeURIComponent(params.get("token")??"")}`;
  const html=`<!doctype html><html><head><meta name="referrer" content="no-referrer"><title>Walshken print</title><style>body{margin:0;background:white}img{display:block;width:100%;break-after:page}button{margin:16px;padding:12px}@media print{button{display:none}img{max-height:98vh;object-fit:contain}}@page{margin:8mm}</style></head><body><button onclick="window.print()">Print document</button>${Array.from({length:version.page_count},(_,i)=>`<img alt="Document page ${i+1}" src="${url}&amp;page=${i+1}">`).join("")}</body></html>`;
  return new Response(html,{headers:{...headers,"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"}});
 }
 const bytes=await getDocumentObject(db,version.storage_key);
 if(bytes.length!==version.bytes||createHash("sha256").update(bytes).digest("hex")!==version.sha256)return fail(409,"Stored content verification failed. Contact an administrator.");
 // Fresh authorization immediately before delivering data, after storage/render work.
 const recheck=async()=>{const fresh=await currentActor(db,request);if(!fresh||needsStaffMfa(fresh))return fail(401,"Sign in again to open this document.");return requireDocumentPermission(db,fresh,await documentContext(db,fresh,token.document),token.purpose);};
 if(token.purpose==="download"){
  await recheck();await documentEvent(db,actor,"Downloaded",token.document,"Original file delivered",null,version.id);
  return new Response(new Uint8Array(bytes),{headers:{...headers,"Content-Type":"application/octet-stream","Content-Disposition":`attachment; filename*=UTF-8''${encodeURIComponent(version.filename).replace(/'/g,"%27")}`,"Content-Security-Policy":"sandbox; default-src 'none'"}});
 }
 const page=integer(params.get("page")??"1","page",1,version.page_count),watermark=context.document!.watermark?`${actor.name} · ${actor.employee_no} · ${actor.email} · ${now().slice(0,16)} UTC`:"";
 const image=await renderDocumentPage(version.filename,bytes,page,watermark);await recheck();
 await documentEvent(db,actor,token.purpose==="print"?"Print page opened":"Preview page opened",token.document,`Page ${page}`,null,version.id);
 return new Response(new Uint8Array(image),{headers:{...headers,"Content-Type":"image/jpeg","Content-Disposition":"inline","Content-Security-Policy":"default-src 'none'; sandbox"}});
}
