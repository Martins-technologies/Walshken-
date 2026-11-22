import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { storageClient, validateStorage, type RecordingStorage } from "./livekit";
import { decryptSettings, fail, one, type Db } from "./server";

export async function documentStorage(db:Db){
 const key=process.env.WALSHKEN_DOCUMENT_STORAGE_ID??"document-storage";
 const integration=await one<{configuration:string}>(db,"SELECT configuration FROM integrations WHERE id=? AND enabled=1",key);
 let settings:RecordingStorage;
 if(integration)settings=validateStorage(await decryptSettings(key,integration.configuration) as RecordingStorage);
 else{
  // Reuse the existing encrypted S3 account server-side with a distinct private bucket.
  // A disabled document integration must never silently fall back to another credential.
  if(await one(db,"SELECT id FROM integrations WHERE id=?",key))return fail(503,"Document storage is disabled by an administrator.");
  const bucket=process.env.WALSHKEN_DOCUMENT_BUCKET,shared=await one<{configuration:string}>(db,"SELECT configuration FROM integrations WHERE id='recording-storage' AND enabled=1");
  if(!bucket||!shared)return fail(503,"An administrator must connect private document storage.");
  settings=validateStorage({...await decryptSettings("recording-storage",shared.configuration) as RecordingStorage,bucket});
 }
 if(settings.bucket==="walshken-call-recordings")return fail(503,"Document storage must use a separate private bucket.");
 return settings;
}
export async function putDocumentObject(db:Db,key:string,bytes:Buffer,mime:string){
 const settings=await documentStorage(db),client=storageClient(settings);
 try{await client.send(new PutObjectCommand({Bucket:settings.bucket,Key:key,Body:bytes,ContentType:mime,CacheControl:"private, no-store"}));}
 finally{client.destroy();}
}
export async function getDocumentObject(db:Db,key:string){
 const settings=await documentStorage(db),client=storageClient(settings);
 try{const response=await client.send(new GetObjectCommand({Bucket:settings.bucket,Key:key}));if(!response.Body)return fail(404,"The stored file is unavailable.");return Buffer.from(await response.Body.transformToByteArray());}
 finally{client.destroy();}
}
export async function deleteDocumentObject(db:Db,key:string){
 const settings=await documentStorage(db),client=storageClient(settings);
 try{await client.send(new DeleteObjectCommand({Bucket:settings.bucket,Key:key}));}finally{client.destroy();}
}
