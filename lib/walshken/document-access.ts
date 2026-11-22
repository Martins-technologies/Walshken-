import { all, fail, id, now, one, run, type Actor, type Db } from "./server";
import { communicationPolicy } from "./collaboration";
import { allDocumentPermissions, documentPermissions, permissionBit, type DocumentEntry, type DocumentPermission, type DocumentRule, type FolderEntry } from "./document-types";

export const documentsEnabled=()=>process.env.WALSHKEN_DOCUMENTS_ENABLED==="1";
export const documentAdministrator=(actor:Actor)=>actor.role==="super_admin";
export function requireDocuments(){if(!documentsEnabled())return fail(404,"Document management is not enabled on this deployment.");}
export async function documentGroups(db:Db,actor:Actor){
 const policy=await communicationPolicy(db,actor);
 if(actor.role==="guest")return [] as {id:string;title:string}[];
 return all<{id:string;title:string}>(db,`SELECT c.id,c.title FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id
 WHERE c.org_id=? AND m.employee_id=? AND c.status='Active' AND c.kind<>'Direct' AND (c.closes_at IS NULL OR c.closes_at>?)
 AND (?=1 OR c.kind<>'External') AND (c.kind<>'Private' OR ?=1)
 AND ((?=1 AND c.created_by=?) OR ((c.department_id IS NULL OR c.department_id=?) AND (c.country IS NULL OR c.country=?)
 AND (c.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=c.project_id AND p.org_id=c.org_id
 AND (p.owner_id=? OR p.department_id=? OR EXISTS(SELECT 1 FROM tasks t WHERE t.project_id=p.id AND t.employee_id=?)))))) ORDER BY c.title`,
 actor.org_id,actor.id,now(),policy.external_messaging,["super_admin","admin","manager","hr"].includes(actor.role)?1:0,documentAdministrator(actor)?1:0,actor.id,
 actor.department_id,actor.country,actor.id,actor.department_id,actor.id);
}
export type AccessContext={document?:DocumentEntry;folders:FolderEntry[];department:string|null;group:string|null};
export async function documentContext(db:Db,actor:Actor,documentId?:string,folderId?:string):Promise<AccessContext>{
 let document:DocumentEntry|undefined;
 if(documentId){
  document=await one<DocumentEntry>(db,"SELECT * FROM doc_entries WHERE id=? AND org_id=?",documentId,actor.org_id)??undefined;
  if(!document||document.revoked_at||document.deleted_at)return fail(404,"This document is unavailable or access was revoked.");
  folderId=document.folder_id??undefined;
 }
 const folders:FolderEntry[]=[];const seen=new Set<string>();
 while(folderId){
  if(seen.has(folderId)||seen.size>=30)return fail(409,"The folder hierarchy needs administrator review.");seen.add(folderId);
  const folder=await one<FolderEntry>(db,"SELECT * FROM doc_folders WHERE id=? AND org_id=?",folderId,actor.org_id);
  if(!folder||folder.revoked_at)return fail(404,"This folder is unavailable or access was revoked.");folders.push(folder);folderId=folder.parent_id??undefined;
 }
 return {document,folders,department:document?.department_id??folders.find(f=>f.department_id)?.department_id??null,group:document?.group_id??folders.find(f=>f.group_id)?.group_id??null};
}
export type DocumentEvaluation={rules:DocumentRule[];groups:Map<string,Set<string>>};
export async function documentEvaluation(db:Db,actor:Actor):Promise<DocumentEvaluation>{return {rules:await all<DocumentRule>(db,"SELECT * FROM doc_acl WHERE org_id=? AND (expires_at IS NULL OR expires_at>?)",actor.org_id,now()),groups:new Map([[actor.id,new Set((await documentGroups(db,actor)).map(g=>g.id))]])};}
export async function documentMask(db:Db,actor:Actor,context:AccessContext,depth=0,evaluation?:DocumentEvaluation):Promise<number>{
 if(actor.status!=="Active"||actor.employment_status==="Ended")return 0;
 if(documentAdministrator(actor))return allDocumentPermissions;
 if(depth>6)return 0;
 let groups=evaluation?.groups.get(actor.id);if(!groups){groups=new Set((await documentGroups(db,actor)).map(g=>g.id));evaluation?.groups.set(actor.id,groups);}
 const scopes:[string,string][]=[["organization",actor.org_id],...context.folders.map(f=>["folder",f.id] as [string,string])];
 if(context.department)scopes.push(["department",context.department]);if(context.group)scopes.push(["group",context.group]);if(context.document)scopes.push(["document",context.document.id]);
 const rules=evaluation?evaluation.rules.filter(rule=>scopes.some(([type,target])=>rule.scope_type===type&&rule.scope_id===target)):
  await all<DocumentRule>(db,`SELECT * FROM doc_acl WHERE org_id=? AND (expires_at IS NULL OR expires_at>?) AND (${scopes.map(()=>"(scope_type=? AND scope_id=?)").join(" OR ")})`,actor.org_id,now(),...scopes.flat());
 let allowed=0,denied=0;
 for(const rule of rules){
  if(rule.effect==="allow"&&actor.role==="guest"&&(rule.scope_type!=="document"||rule.principal_type!=="employee"||rule.principal_id!==actor.id))continue;
  const matches=rule.principal_type==="all"?(actor.role!=="guest"||rule.effect==="deny")&&(rule.scope_type!=="department"||actor.department_id===rule.scope_id)&&(rule.scope_type!=="group"||groups.has(rule.scope_id))
   :rule.principal_type==="employee"?rule.principal_id===actor.id
   :rule.principal_type==="role"?rule.principal_id===actor.role
   :rule.principal_type==="department"?rule.principal_id===actor.department_id
   :rule.principal_type==="group"?groups.has(rule.principal_id):false;
  if(!matches)continue;
  if(rule.effect==="deny"){denied|=rule.mask;continue;}
  if(rule.source_actor&&rule.source_document){
   const source=await one<Actor>(db,"SELECT * FROM employees WHERE id=? AND org_id=? AND status='Active' AND employment_status<>'Ended'",rule.source_actor,actor.org_id);
   if(!source)continue;
   let sourceMask=0;try{sourceMask=await documentMask(db,source,await documentContext(db,source,rule.source_document),depth+1,evaluation);}catch{continue;}
   const required=permissionBit("view")|permissionBit(actor.role==="guest"?"external":"forward");
   if((sourceMask&required)!==required)continue;
  }
  allowed|=rule.mask;
 }
 const result=allowed&~denied;
 // View is mandatory for every operation on an existing file, even if an isolated action was granted.
 return context.document&&!(result&permissionBit("view"))?0:result;
}
export async function requireDocumentPermission(db:Db,actor:Actor,context:AccessContext,permission:DocumentPermission){
 const mask=await documentMask(db,actor,context);if(!(mask&permissionBit(permission)))return fail(403,`You do not have ${permission} permission for this item.`);return mask;
}
export const allowedDocumentActions=(mask:number)=>documentPermissions.filter(p=>mask&permissionBit(p));
export async function documentEvent(db:Db,actor:Actor,action:string,documentId:string|null=null,detail="",recipient:string|null=null,versionId:string|null=null,folderId:string|null=null){
 await run(db,"INSERT INTO doc_events(id,org_id,actor_id,document_id,folder_id,action,detail,recipient_id,version_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",id(),actor.org_id,actor.id,documentId,folderId,action,detail.slice(0,1000),recipient,versionId,now());
}
export async function documentLock(db:Db,actor:Actor,documentId?:string){
 // Serialize policy changes, revocation and file mutations for this organization.
 await one(db,"SELECT id FROM organizations WHERE id=? FOR UPDATE",actor.org_id);
 if(documentId)await one(db,"SELECT id FROM doc_entries WHERE id=? AND org_id=? FOR UPDATE",documentId,actor.org_id);
}
