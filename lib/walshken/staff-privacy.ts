import {publicEmployeeCalculation} from './employer-validation';
import {disposalAction,disposalData} from './source-disposal';
import {createHash} from 'node:crypto';
import {enterpriseEnabled} from './payroll-statutory';
import {actionScope,hasAction,requireEmployeeAction} from './staff-authority';
import {assertNoLegalHold,assertRecordRetention,retentionCategories} from './retention';
import {deleteDocumentObject,getDocumentObject,putDocumentObject} from './document-storage';
import {all,audit,fail,id,json,now,one,pick,requireStaff,run,str,throttle,type Actor,type Db,type Row} from './server';
import {validDay} from './holiday-access';
import {payrollDataset} from './payroll-access';
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
type RequestRow={id:string;org_id:string;employee_id:string;kind:string;category:string;from_date:string;through_date:string;reason:string;created_by:string;state:string;revision:number;created_at:string;artifact_key:string|null;artifact_hash:string|null;artifact_expires_at:string|null};
const enabled=(actor:Actor)=>{requireStaff(actor);if(!enterpriseEnabled())return fail(404,'Privacy workflows are unavailable.');};
const capability=(kind:string)=>kind==='Export'?'privacy.export':kind==='Dispose'?'privacy.dispose':'privacy.manage';
async function access(db:Db,actor:Actor,row:RequestRow,manage=false){
 if(!manage&&row.employee_id===actor.id&&row.kind==='Export')return;
 await requireEmployeeAction(db,actor,capability(row.kind),row.employee_id,false);
}
async function event(db:Db,actor:Actor,target:string,action:string,detail:string){await run(db,'INSERT INTO staff_privacy_request_events(id,request_id,org_id,action,actor_id,detail,created_at) VALUES(?,?,?,?,?,?,?)',id(),target,actor.org_id,action,actor.id,detail,now());await audit(db,actor,action,'privacy request',target).run();}
export async function privacyData(db:Db,actor:Actor){
 enabled(actor);const s=actionScope(actor,'privacy.manage','e',false),x=actionScope(actor,'privacy.export','e',false),d=actionScope(actor,'privacy.dispose','e',false);
 const rows=await all(db,`SELECT r.*,e.name,a.name AS requested_by,(SELECT count(*)::int FROM staff_privacy_request_events v WHERE v.request_id=r.id) AS event_count
 FROM staff_privacy_requests r JOIN employees e ON e.id=r.employee_id JOIN employees a ON a.id=r.created_by
 WHERE r.org_id=? AND (r.employee_id=? OR (${s.sql}) OR (${x.sql}) OR (${d.sql})) ORDER BY r.created_at DESC,r.id DESC LIMIT 300`,actor.org_id,actor.id,...s.args,...x.args,...d.args);
 const staff=await all(db,`SELECT e.id,e.name,e.country FROM employees e WHERE e.org_id=? AND e.role<>'guest' AND (e.id=? OR (${s.sql}) OR (${x.sql}) OR (${d.sql})) ORDER BY e.name`,actor.org_id,actor.id,...s.args,...x.args,...d.args);
 const events=await all(db,`SELECT v.*,e.name FROM staff_privacy_request_events v JOIN staff_privacy_requests r ON r.id=v.request_id JOIN employees subject ON subject.id=r.employee_id JOIN employees e ON e.id=v.actor_id WHERE v.org_id=? AND r.id IN (${rows.length?rows.map(()=>'?').join(','):'NULL'}) ORDER BY v.created_at,v.id`,actor.org_id,...rows.map(r=>r.id));
 return json({...(process.env.WALSHKEN_SOURCE_DISPOSAL_ENABLED==='1'&&hasAction(actor,'privacy.dispose')?await disposalData(db,actor):{}),privacy:true,rows,staff,events,categories:retentionCategories,actorId:actor.id,canManage:hasAction(actor,'privacy.manage'),canExport:hasAction(actor,'privacy.export'),canDispose:hasAction(actor,'privacy.dispose')});
}
async function collect(db:Db,actor:Actor,row:RequestRow){
 const target=row.employee_id,stage=payrollDataset(),from=row.from_date,to=row.through_date+'T23:59:59.999Z';
 const sqls:Record<string,{sql:string;args:unknown[]}[]>={
 'Employee records':[{sql:`SELECT employee_no,name,email,role,status,title,country,jurisdiction,time_zone,employment_type,hire_date,contract_start,employment_end,phone,expected_hours,break_policy,leave_days,created_at,activated_at,first_login_at,last_login_at,work_schedule,holiday_calendar,employment_status,holiday_days FROM employees WHERE id=? AND org_id=?`,args:[target,actor.org_id]}],
 Attendance:[{sql:'SELECT * FROM attendance WHERE employee_id=? AND org_id=? AND release_stage=? AND starts_at>=? AND starts_at<=? ORDER BY starts_at,id',args:[target,actor.org_id,stage,from,to]}, {sql:'SELECT b.* FROM breaks b JOIN attendance a ON a.id=b.attendance_id WHERE a.employee_id=? AND a.org_id=? AND a.release_stage=? AND a.starts_at>=? AND a.starts_at<=? ORDER BY b.starts_at,b.id',args:[target,actor.org_id,stage,from,to]}],
 Timesheets:[{sql:'SELECT * FROM timesheets WHERE employee_id=? AND org_id=? AND release_stage=? AND work_date>=? AND work_date<=? ORDER BY work_date,id',args:[target,actor.org_id,stage,from,row.through_date]}],
 Payroll:[{sql:"SELECT p.* FROM payroll p WHERE employee_id=? AND org_id=? AND release_stage=? AND status='Finalized' AND starts_on>=? AND ends_on<=? ORDER BY starts_on,id",args:[target,actor.org_id,stage,from,row.through_date]}],
 Payslips:[{sql:"SELECT id,starts_on,ends_on,currency,calculation,calculation_hash,status FROM payroll WHERE employee_id=? AND org_id=? AND release_stage=? AND status='Finalized' AND starts_on>=? AND ends_on<=? ORDER BY starts_on,id",args:[target,actor.org_id,stage,from,row.through_date]}],
 Documents:[{sql:'SELECT id,name,description,category,created_at,updated_at,deleted_at,revoked_at FROM doc_entries WHERE owner_id=? AND org_id=? AND created_at>=? AND created_at<=? ORDER BY created_at,id',args:[target,actor.org_id,from,to]}],
 'Audit history':[{sql:"SELECT id,action,entity,target_id,created_at FROM audit WHERE org_id=? AND (actor_id=? OR (entity IN ('employee','identity') AND target_id=?)) AND created_at>=? AND created_at<=? ORDER BY created_at,id",args:[actor.org_id,target,target,from,to]}],
 Messages:[{sql:'SELECT m.id,m.conversation_id,m.body,m.reply_to,m.edited_at,m.deleted_at,m.created_at FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.sender_id=? AND c.org_id=? AND m.created_at>=? AND m.created_at<=? ORDER BY m.created_at,m.id',args:[target,actor.org_id,from,to]}],
 'Meeting metadata':[{sql:'SELECT m.id,m.title,m.starts_at,m.ends_at,m.mode,m.started_at,m.ended_at,m.cancelled_at FROM meetings m WHERE m.org_id=? AND (m.organizer_id=? OR EXISTS(SELECT 1 FROM meeting_members p WHERE p.meeting_id=m.id AND p.employee_id=?)) AND m.starts_at>=? AND m.starts_at<=? ORDER BY m.starts_at,m.id',args:[actor.org_id,target,target,from,to]}],
 'Leave records':[{sql:'SELECT * FROM leave_requests WHERE org_id=? AND employee_id=? AND release_stage=? AND starts_on>=? AND ends_on<=? ORDER BY starts_on,id',args:[actor.org_id,target,stage,from,row.through_date]}],
 };
 const categories=row.category==='All'?retentionCategories:[pick(row.category,retentionCategories,'record category')],records:Record<string,unknown>={};
 for(const category of categories){const results=[];for(const q of sqls[category]){const data=await all(db,q.sql+' LIMIT 10001',...q.args);if(data.length>10000)return fail(413,'Narrow the privacy request date range; the export would exceed 10,000 records in one dataset.');for(const record of data)if(typeof record.calculation==='string')record.calculation=JSON.stringify(publicEmployeeCalculation(JSON.parse(record.calculation)));results.push(data);}records[category]=results;}
 const content=Buffer.from(JSON.stringify({format:'Walshken personal data export v1',request:row.id,employee:target,from,through:row.through_date,generatedAt:now(),scope:'Employee-owned records; finalized payroll; authored messages; document metadata. Passwords, MFA secrets, access tokens, other participants’ messages and original files are excluded.',records}));
 if(content.length>25*1024*1024)return fail(413,'Narrow the date range to keep the private export under 25 MB.');return content;
}
export async function privacyAction(db:Db,actor:Actor,action:string,data:Record<string,unknown>){
 enabled(actor);if(action.startsWith('source-')){if(process.env.WALSHKEN_SOURCE_DISPOSAL_ENABLED!=='1')return fail(404,'Original-record disposal is unavailable.');return disposalAction(db,actor,action.slice(7),data);}await throttle(db,'privacy:'+actor.id,30,60000);
 if(action==='create'){
  const kind=pick(data.kind,['Export','Archive','Restore','Dispose'] as const,'privacy operation'),employee=str(data.employee,'employee',80),category=pick(data.category,['All',...retentionCategories],'record category');
  if(!(kind==='Export'&&employee===actor.id))await requireEmployeeAction(db,actor,capability(kind),employee,false);
  const from=validDay(data.from,'start date'),through=validDay(data.through,'end date');if(from>through)return fail(400,'Choose ordered request dates.');
  const target=id();await db.transaction(async tx=>{await run(tx,'INSERT INTO staff_privacy_requests(id,org_id,employee_id,kind,category,from_date,through_date,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',target,actor.org_id,employee,kind,category,from,through,str(data.reason,'purpose and authority',2000),actor.id,now());await event(tx,actor,target,'Privacy request created',kind+' · '+category);});return json({ok:true,message:'Request submitted for independent authorization.',id:target},201);
 }
 if(action==='cleanup'){
  if(!hasAction(actor,'privacy.manage'))return fail(403,'Privacy management authority is required.');
  const q=await all<{id:string;org_id:string;storage_key:string;employee_id:string;request_id:string}>(db,`SELECT q.* FROM staff_privacy_cleanup q JOIN employees e ON e.id=q.employee_id WHERE q.org_id=? AND (${actionScope(actor,'privacy.manage','e',false).sql}) AND q.created_at<? ORDER BY q.created_at LIMIT 20`,actor.org_id,...actionScope(actor,'privacy.manage','e',false).args,new Date(Date.now()-300000).toISOString());let removed=0,failed=0;
  for(const item of q){if(await one(db,'SELECT id FROM staff_privacy_requests WHERE artifact_key=? AND (artifact_expires_at IS NULL OR artifact_expires_at>?)',item.storage_key,now()))continue;
   try{await assertNoLegalHold(db,actor.org_id,'employee',item.employee_id,item.employee_id);
   const original=await one<RequestRow>(db,'SELECT * FROM staff_privacy_requests WHERE id=? AND org_id=?',item.request_id,actor.org_id);if(original?.kind==='Archive'){const person=await one<{country:string}>(db,'SELECT country FROM employees WHERE id=? AND org_id=?',item.employee_id,actor.org_id);if(!person)continue;for(const category of original.category==='All'?retentionCategories:[original.category])await assertRecordRetention(db,actor.org_id,person.country,category,original.created_at);}
   await deleteDocumentObject(db,item.storage_key);await run(db,'DELETE FROM staff_privacy_cleanup WHERE id=?',item.id);removed++;}catch{failed++;}}
  return json({ok:true,message:`Private archive cleanup: ${removed} removed, ${failed} awaiting retry.`});
 }
 if(action==='execute'){
  const pending=await one<RequestRow>(db,'SELECT * FROM staff_privacy_requests WHERE id=? AND org_id=?',str(data.id,'request',80),actor.org_id);if(!pending)return fail(404,'Privacy request unavailable.');await access(db,actor,pending,true);
  if(['Export','Archive','Restore'].includes(pending.kind))await run(db,'INSERT INTO staff_privacy_cleanup(id,org_id,employee_id,request_id,storage_key,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(storage_key) DO UPDATE SET created_at=LEAST(staff_privacy_cleanup.created_at,excluded.created_at)',id(),actor.org_id,pending.employee_id,pending.id,`privacy/${actor.org_id}/${pending.employee_id}/${pending.id}.json`,now());
 }
 return db.transaction(async tx=>{
  const row=await one<RequestRow>(tx,'SELECT * FROM staff_privacy_requests WHERE id=? AND org_id=? FOR UPDATE',str(data.id,'request',80),actor.org_id);if(!row)return fail(404,'Privacy request unavailable.');await access(tx,actor,row,true);
  if(Number(data.revision)!==row.revision)return fail(409,'This request changed. Refresh before continuing.');
  if(action==='review'){
   if(row.state!=='Pending')return fail(409,'This request already has a decision.');if(row.created_by===actor.id)return fail(403,'A separate authorized administrator must review the request.');
   const state=pick(data.decision,['Approved','Rejected'],'decision');await run(tx,'UPDATE staff_privacy_requests SET state=?,revision=revision+1 WHERE id=?',state,row.id);await event(tx,actor,row.id,'Privacy request '+state.toLowerCase(),str(data.reason,'independent decision evidence',2000));return json({ok:true,message:'Decision recorded.'});
  }
  if(action==='cancel'){
   if(!['Pending','Approved'].includes(row.state))return fail(409,'Only a pending or approved request can be cancelled.');await run(tx,"UPDATE staff_privacy_requests SET state='Cancelled',revision=revision+1 WHERE id=?",row.id);await event(tx,actor,row.id,'Privacy request cancelled',str(data.reason,'cancellation reason',1000));return json({ok:true,message:'Request cancelled.'});
  }
  if(action!=='execute')return fail(404,'Privacy action unavailable.');if(row.state!=='Approved')return fail(409,'Independent approval is required before execution.');
  const at=now();let key:string|null=null,hash:string|null=null,expiry:string|null=null;
  if(row.kind==='Export'||row.kind==='Archive'){
   const bytes=await collect(tx,actor,row);key=`privacy/${actor.org_id}/${row.employee_id}/${row.id}.json`;hash=sha(bytes);await putDocumentObject(tx,key,bytes,'application/json');expiry=row.kind==='Export'?new Date(Date.now()+24*3600000).toISOString():null;
   await event(tx,actor,row.id,row.kind==='Export'?'Private export generated':'Immutable archive snapshot created',JSON.stringify({hash,bytes:bytes.length,expires:expiry}));
  }else{
   // Disposal affects approved archive copies. Operational payroll/audit records keep
   // their original retention and immutable-history protections.
   await assertNoLegalHold(tx,actor.org_id,'employee',row.employee_id,row.employee_id);
   const archives=await all<RequestRow>(tx,"SELECT * FROM staff_privacy_requests WHERE org_id=? AND employee_id=? AND kind='Archive' AND state='Completed' AND category=? AND from_date=? AND through_date=? AND artifact_key IS NOT NULL FOR UPDATE",actor.org_id,row.employee_id,row.category,row.from_date,row.through_date);
   if(!archives.length)return fail(409,'No retained archive snapshot matches this exact category and date range.');
   const employee=await one<{country:string}>(tx,'SELECT country FROM employees WHERE id=? AND org_id=?',row.employee_id,actor.org_id);if(!employee)return fail(404,'Employee unavailable.');
   for(const source of archives){if(row.kind==='Dispose')for(const category of row.category==='All'?retentionCategories:[row.category])await assertRecordRetention(tx,actor.org_id,employee.country,category,source.created_at);
    const bytes=await getDocumentObject(tx,source.artifact_key!);if(sha(bytes)!==source.artifact_hash)return fail(409,'Archive integrity check failed.');
    if(row.kind==='Restore'){key=`privacy/${actor.org_id}/${row.employee_id}/${row.id}.json`;hash=sha(bytes);expiry=new Date(Date.now()+24*3600000).toISOString();await putDocumentObject(tx,key,bytes,'application/json');await event(tx,actor,row.id,'Archive restored for private download',source.id);break;}
    await run(tx,'INSERT INTO staff_privacy_cleanup(id,org_id,employee_id,request_id,storage_key,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(storage_key) DO UPDATE SET created_at=LEAST(staff_privacy_cleanup.created_at,excluded.created_at)',id(),actor.org_id,row.employee_id,source.id,source.artifact_key!,new Date(Date.now()-300001).toISOString());await run(tx,'UPDATE staff_privacy_requests SET artifact_key=NULL,revision=revision+1 WHERE id=?',source.id);await event(tx,actor,row.id,'Retained archive copy revoked and queued for destruction',JSON.stringify({archive:source.id,hash:source.artifact_hash}));
   }
  }
  await run(tx,"UPDATE staff_privacy_requests SET state='Completed',revision=revision+1,completed_at=?,artifact_key=?,artifact_hash=?,artifact_expires_at=? WHERE id=?",at,key,hash,expiry,row.id);return json({ok:true,message:row.kind==='Dispose'?'Eligible archive copies revoked and queued for storage cleanup; operational records retain their separate protections.':'Privacy operation completed.'});
 });
}
export async function privacyDownload(db:Db,actor:Actor,target:string){
 enabled(actor);const row=await one<RequestRow>(db,"SELECT * FROM staff_privacy_requests WHERE id=? AND org_id=? AND state='Completed'",target,actor.org_id);if(!row)return fail(404,'Private export unavailable.');await access(db,actor,row);
 if(!row.artifact_key||row.artifact_expires_at&&row.artifact_expires_at<=now())return fail(410,'This export expired or was disposed. Request a new authorized copy.');
 const bytes=await getDocumentObject(db,row.artifact_key);if(sha(bytes)!==row.artifact_hash)return fail(409,'Archive integrity verification failed.');await event(db,actor,row.id,'Private export downloaded','Access checked at download time');return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/json','Content-Disposition':`attachment; filename="walshken-records-${row.from_date}-${row.through_date}.json"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
