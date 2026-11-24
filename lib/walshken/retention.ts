import {employmentEngineEnabled} from './employment-catalog';
import {all,audit,fail,id,integer,json,now,one,pick,requireSuper,run,str,type Actor,type Db} from './server';
import {validDay} from './holiday-access';

export const retentionCategories=['Employee records','Attendance','Timesheets','Payroll','Payslips','Documents','Audit history','Messages','Meeting metadata','Leave records'] as const;
export async function retentionData(db:Db,actor:Actor){
 if(!employmentEngineEnabled())return null;
 requireSuper(actor);
 const [versions,holds]=await Promise.all([
  all(db,`SELECT v.*,COALESCE(r.decision,'Pending') AS status FROM staff_retention_versions v LEFT JOIN staff_retention_reviews r ON r.version_id=v.id WHERE v.org_id=? ORDER BY v.effective_on DESC,v.created_at DESC LIMIT 300`,actor.org_id),
  all(db,`SELECT h.*,r.created_at AS released_at,r.reason AS release_reason FROM staff_legal_holds h LEFT JOIN staff_legal_hold_releases r ON r.hold_id=h.id WHERE h.org_id=? ORDER BY h.created_at DESC LIMIT 300`,actor.org_id),
 ]);
 return {versions,holds};
}
export async function assertNoLegalHold(db:Db,org:string,type:string,target:string,owner?:string){
 if(!employmentEngineEnabled())return;
 const hold=await one(db,`SELECT h.id FROM staff_legal_holds h WHERE h.org_id=? AND NOT EXISTS(SELECT 1 FROM staff_legal_hold_releases r WHERE r.hold_id=h.id)
  AND (h.scope_type='organization' OR (h.scope_type=? AND h.target_id=?) OR(h.scope_type='employee' AND h.target_id=?)) LIMIT 1`,org,type,target,owner??'');
 if(hold)return fail(409,'An active legal hold protects these records from deletion.');
}
export async function retentionAction(db:Db,actor:Actor,action:string,data:Record<string,unknown>){
 requireSuper(actor);
 if(!employmentEngineEnabled())return fail(404,'Retention management is unavailable.');
 return db.transaction(async tx=>{
  await one(tx,'SELECT id FROM organizations WHERE id=? FOR UPDATE',actor.org_id);
  if(action==='retention-save'){
   const country=pick(data.country,['CA','IN','PK'],'country'),category=pick(data.category,retentionCategories,'record type');
   const minimum=integer(data.minimumDays,'verified minimum retention days',0,36500),days=integer(data.retainDays,'retention days',minimum,36500),source=str(data.source,'legal source or contractual retention reference',1500);
   let url:URL;try{url=new URL(source);}catch{return fail(400,'Enter an HTTPS retention source.');}
   if(url.protocol!=='https:'||url.username||url.password)return fail(400,'Enter an HTTPS retention source.');
   const target=id();await run(tx,'INSERT INTO staff_retention_versions(id,org_id,country,category,classification,retain_days,minimum_days,effective_on,source_url,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',target,actor.org_id,country,category,str(data.classification,'data classification',100),days,minimum,validDay(data.effectiveOn,'retention effective date'),url.href,str(data.reason,'retention applicability and change reason',2000),actor.id,now());
   await audit(tx,actor,'Retention version proposed','retention',target).run();
   return json({ok:true,message:'Retention proposal saved for independent review. Expiry alone does not authorize destruction.'},201);
  }
  if(action==='retention-review'){
   const target=str(data.id,'retention version',80),row=await one<{created_by:string}>(tx,'SELECT created_by FROM staff_retention_versions WHERE id=? AND org_id=?',target,actor.org_id);
   if(!row)return fail(404,'Retention proposal unavailable.');
   if(row.created_by===actor.id)return fail(403,'A separate Super Admin must verify retention requirements.');
   if(await one(tx,'SELECT id FROM staff_retention_reviews WHERE version_id=?',target))return fail(409,'This version already has a decision.');
   await run(tx,'INSERT INTO staff_retention_reviews(id,version_id,decision,actor_id,reason,created_at) VALUES(?,?,?,?,?,?)',id(),target,pick(data.decision,['Approved','Rejected'],'decision'),actor.id,str(data.reason,'legal review evidence',2000),now());
   await audit(tx,actor,'Retention version reviewed','retention',target).run();
   return json({ok:true,message:'Retention decision recorded.'});
  }
  if(action==='hold-create'){
   const scope=pick(data.scope,['organization','employee','document','conversation','payroll period'] as const,'hold scope');
   const target=scope==='organization'?actor.org_id:str(data.target,'protected record ID',80);
   const tables={employee:'employees',document:'doc_entries',conversation:'conversations','payroll period':'payroll_periods'} as const;
   if(scope!=='organization'&&!await one(tx,`SELECT id FROM ${tables[scope]} WHERE org_id=? AND id=?`,actor.org_id,target))return fail(404,'Protected record unavailable.');
   const record=id();await run(tx,'INSERT INTO staff_legal_holds(id,org_id,scope_type,target_id,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?)',record,actor.org_id,scope,target,str(data.reason,'legal hold authority and case reference',2000),actor.id,now());
   await audit(tx,actor,'Legal hold placed','legal hold',record).run();
   return json({ok:true,message:'Legal hold recorded.'},201);
  }
  if(action==='hold-release'){
   const target=str(data.id,'legal hold',80),hold=await one<{created_by:string}>(tx,'SELECT created_by FROM staff_legal_holds WHERE org_id=? AND id=?',actor.org_id,target);
   if(!hold)return fail(404,'Legal hold unavailable.');
   if(hold.created_by===actor.id)return fail(403,'A separate Super Admin must verify a legal hold release.');
   if(await one(tx,'SELECT hold_id FROM staff_legal_hold_releases WHERE hold_id=?',target))return fail(409,'The hold is already released.');
   await run(tx,'INSERT INTO staff_legal_hold_releases(hold_id,actor_id,reason,created_at) VALUES(?,?,?,?)',target,actor.id,str(data.reason,'release authority and evidence',2000),now());
   await audit(tx,actor,'Legal hold released','legal hold',target).run();
   return json({ok:true,message:'Legal hold released with its history preserved.'});
  }
  return fail(404,'Privacy action unavailable.');
 });
}

export async function assertRecordRetention(db:Db,org:string,country:string,category:string,createdAt:string){
 if(!employmentEngineEnabled())return;
 const rule=await one<{retain_days:number}>(db,`SELECT v.retain_days FROM staff_retention_versions v
  JOIN staff_retention_reviews r ON r.version_id=v.id AND r.decision='Approved'
  WHERE v.org_id=? AND v.country=? AND v.category=? AND v.effective_on<=? ORDER BY v.effective_on DESC,v.created_at DESC,v.id DESC LIMIT 1`,org,country,category,now().slice(0,10));
 if(!rule)return fail(409,'Configure and independently review the applicable '+category.toLowerCase()+' retention policy before destruction.');
 if(Date.parse(now())-Date.parse(createdAt)<rule.retain_days*86400000)return fail(409,'The verified record retention period has not elapsed.');
}
export async function validateMessageRetention(db:Db,org:string,days:number){
 if(!employmentEngineEnabled())return;
 const countries=await all<{country:string}>(db,"SELECT DISTINCT country FROM employees WHERE org_id=? AND role<>'guest'",org);
 for(const entry of countries){
  const rule=await one<{retain_days:number}>(db,`SELECT v.retain_days FROM staff_retention_versions v
   JOIN staff_retention_reviews r ON r.version_id=v.id AND r.decision='Approved'
   WHERE v.org_id=? AND v.country=? AND v.category='Messages' AND v.effective_on<=? ORDER BY v.effective_on DESC,v.created_at DESC,v.id DESC LIMIT 1`,org,entry.country,now().slice(0,10));
  if(!rule||days<rule.retain_days)return fail(409,'Review message retention for every staff employment country before purging content.');
 }
}
