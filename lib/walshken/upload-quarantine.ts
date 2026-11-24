import {createHash} from 'node:crypto';
import {deleteDocumentObject,putDocumentObject} from './document-storage';
import {all,audit,fail,id,now,one,run,type Actor,type Db} from './server';

type ScanState='Pending'|'Scanning'|'Clean'|'Infected'|'Failed'|'Quarantined';
export async function quarantinedUpload(db:Db,actor:Actor,bytes:Buffer,name:string,scan:()=>Promise<'clean'|'infected'>) {
 const target=id(),at=now(),key=`walshken/${actor.org_id}/quarantine/${target}`;
 const sha256=createHash('sha256').update(bytes).digest('hex');
 await run(db,`INSERT INTO staff_upload_scans(id,org_id,employee_id,sha256,file_name,storage_key,created_at,status,updated_at)
  VALUES(?,?,?,?,?,?,?,'Pending',?)`,target,actor.org_id,actor.id,sha256,name.slice(0,200),key,at,at);
 const transition=async(status:ScanState)=>{
  await db.transaction(async tx=>{
   await run(tx,'UPDATE staff_upload_scans SET status=?,updated_at=? WHERE id=?',status,now(),target);
   await run(tx,'INSERT INTO staff_upload_scan_events(id,scan_id,org_id,status,actor_id,created_at) VALUES(?,?,?,?,?,?)',id(),target,actor.org_id,status,actor.id,now());
   await audit(tx,actor,`Upload scan ${status.toLowerCase()}`,'upload scan',target).run();
  });
 };
 await transition('Pending');
 let verdict:'clean'|'infected';
 try {
  await putDocumentObject(db,key,bytes,'application/octet-stream');
  await transition('Scanning');
  verdict=await scan();
 }catch {
  await transition('Failed');
  return fail(503,'Upload screening is unavailable. The file has not been released. Contact your administrator.');
 }
 if(verdict==='infected'){
  await transition('Infected');
  await transition('Quarantined');
  const recipients=await all<{id:string}>(db,"SELECT id FROM employees WHERE org_id=? AND role='super_admin' AND status='Active' AND employment_status<>'Ended'",actor.org_id);
  for(const person of recipients)await run(db,'INSERT INTO notifications(id,employee_id,title,body,href) VALUES(?,?,?,?,?)',id(),person.id,'Upload quarantined','A staff upload failed malware screening. Review its scan history in Staff policies.','/staff/governance');
  return fail(422,'The file failed malware screening and remains quarantined.');
 }
 await transition('Clean');
 try{
  await deleteDocumentObject(db,key);
  await run(db,'UPDATE staff_upload_scans SET storage_key=NULL,updated_at=? WHERE id=?',now(),target);
 }catch{/* The private quarantine object remains inaccessible and is retained in the scan record. */}
 return target;
}
export async function scanHistory(db:Db,actor:Actor) {
 return all(db,`SELECT s.id,s.file_name,s.sha256,s.status,s.created_at,s.updated_at,e.name
  FROM staff_upload_scans s JOIN employees e ON e.id=s.employee_id WHERE s.org_id=? ORDER BY s.created_at DESC LIMIT 100`,actor.org_id);
}
