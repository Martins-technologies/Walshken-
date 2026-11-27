import {integrationSettings} from './integration-settings';
import {validateStorage,verifyRecordingStorage,type RecordingStorage} from './livekit';
import {fail,one,type Db} from './server';

const sameLocation=(a:RecordingStorage,b:RecordingStorage)=>
 a.endpoint===b.endpoint&&a.region===b.region&&a.bucket===b.bucket;

async function retainedObjects(db:Db){
 // Integration changes must also protect data whose feature flag is temporarily off.
 const tables=await one<{documents:boolean;privacy:boolean;disposal:boolean}>(db,`SELECT
  to_regclass('doc_versions') IS NOT NULL AS documents,
  to_regclass('staff_privacy_requests') IS NOT NULL AS privacy,
  to_regclass('staff_source_disposal_objects') IS NOT NULL AS disposal`);
 const documents=Boolean(tables?.documents&&(await one(db,`SELECT v.id FROM doc_versions v JOIN doc_entries d ON d.id=v.document_id WHERE d.deleted_at IS NULL LIMIT 1`)
  ||await one(db,'SELECT id FROM doc_object_cleanup LIMIT 1'))
  ||tables?.privacy&&(await one(db,'SELECT id FROM staff_privacy_requests WHERE artifact_key IS NOT NULL LIMIT 1')
  ||await one(db,'SELECT id FROM staff_privacy_cleanup LIMIT 1'))
  ||tables?.disposal&&await one(db,"SELECT id FROM staff_source_disposal_objects WHERE storage_kind='Documents' AND status='Pending' LIMIT 1"));
 const recordings=Boolean(await one(db,'SELECT id FROM meeting_recordings WHERE deleted_at IS NULL LIMIT 1')
  ||tables?.disposal&&await one(db,"SELECT id FROM staff_source_disposal_objects WHERE storage_kind='Recordings' AND status='Pending' LIMIT 1"));
 return {documents,recordings};
}

export async function verifyStorageRotation(db:Db,key:string,value:RecordingStorage,enabled:boolean){
 const next=validateStorage(value);
 if(key==="client-document-storage"){
  const exists=await one<{versions:boolean;staged:boolean}>(db,"SELECT to_regclass('client_document_versions') IS NOT NULL AS versions,to_regclass('client_upload_pending_objects') IS NOT NULL AS staged");
  const retained=!!(exists?.versions&&await one(db,"SELECT v.id FROM client_document_versions v JOIN client_documents d ON d.id=v.document_id WHERE d.deleted_at IS NULL AND v.storage_backend='s3' LIMIT 1")||exists?.staged&&await one(db,"SELECT storage_key FROM client_upload_pending_objects WHERE storage_backend='s3' LIMIT 1"));
  const saved=await integrationSettings(db,key,false),prior=saved?validateStorage(saved as RecordingStorage):null;
  if(retained&&(!prior||!sameLocation(prior,next)))return fail(409,"Retained client files require their existing storage location. Rotate credentials for the same bucket or complete a planned migration.");
  for(const key of ["recording-storage",process.env.WALSHKEN_DOCUMENT_STORAGE_ID??"document-storage"]){
   const setting=await integrationSettings(db,key,false);
   if(setting&&sameLocation(validateStorage(setting as RecordingStorage),next))return fail(400,"Choose a separate private bucket for client documents.");
  }
  if(enabled||retained)await verifyRecordingStorage(next);
  return;
 }
 const retained=await retainedObjects(db);
 const saved=await integrationSettings(db,key,false);
 const current=saved?validateStorage(saved as RecordingStorage):null;
 const documentKey=process.env.WALSHKEN_DOCUMENT_STORAGE_ID??'document-storage';
 const documentSettings=await integrationSettings(db,documentKey,false);
 const usesSharedDocuments=!documentSettings&&Boolean(process.env.WALSHKEN_DOCUMENT_BUCKET);
 const checks:RecordingStorage[]=[];
 if(key==='recording-storage'){
  if(retained.recordings&&(!current||!sameLocation(current,next)))return fail(409,'Retained recordings require the existing endpoint, region and bucket. Rotate credentials for that same location or complete a planned storage migration.');
  if(retained.documents&&usesSharedDocuments){
   if(!current||current.endpoint!==next.endpoint||current.region!==next.region)return fail(409,'Private documents still use this storage account. Keep its endpoint and region while rotating credentials.');
   checks.push({...next,bucket:process.env.WALSHKEN_DOCUMENT_BUCKET!});
  }
  if(enabled||retained.recordings)checks.push(next);
 }else{
  // A dedicated document credential can replace shared credentials without moving files.
  const shared=!current?await integrationSettings(db,'recording-storage',false):null;
  const effective=current??(shared&&process.env.WALSHKEN_DOCUMENT_BUCKET?validateStorage({...shared as RecordingStorage,bucket:process.env.WALSHKEN_DOCUMENT_BUCKET}):null);
  if(retained.documents&&(!effective||!sameLocation(effective,next)))return fail(409,'Retained documents and private archives require the existing endpoint, region and bucket. Rotate credentials for that same location or complete a planned storage migration.');
  if(enabled||retained.documents)checks.push(next);
 }
 // Prove the replacement can access every retained bucket before saving it.
 for(const settings of checks)await verifyRecordingStorage(settings);
}
