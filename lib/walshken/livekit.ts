import { AccessToken, EgressClient, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import { S3Client, HeadBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { decryptSettings, fail, one, type Db } from "./server";

export type LiveKitSettings={url:string;apiKey:string;apiSecret:string};
export type RecordingStorage={endpoint:string;region:string;bucket:string;accessKey:string;secretKey:string};
export function validateLiveKit(settings:LiveKitSettings){
  let url:URL;
  try{url=new URL(settings.url);}catch{return fail(400,"Enter a valid LiveKit WebSocket URL.");}
  const extra=(process.env.WALSHKEN_LIVEKIT_ALLOWED_HOSTS??"").split(",").map(v=>v.trim());
  if(url.protocol!=="wss:"||url.username||url.password||url.port||url.pathname!=="/"||url.search||url.hash||
    !(/^[-a-z0-9]+\.livekit\.cloud$/i.test(url.hostname)||extra.includes(url.hostname)))
    return fail(400,"Use your wss://project.livekit.cloud URL. Self-hosted hosts require the server allowlist.");
  if(!settings.apiKey||!settings.apiSecret)return fail(400,"Enter the LiveKit API key and secret.");
  return {...settings,url:url.origin};
}
export async function liveKitSettings(db:Db){
  const row=await one<{configuration:string}>(db,"SELECT configuration FROM integrations WHERE id='livekit' AND enabled=1");
  if(!row)return fail(409,"A Super Admin must connect LiveKit in Integrations before calls can start.");
  return validateLiveKit(await decryptSettings("livekit",row.configuration) as LiveKitSettings);
}
export const roomClient=(s:LiveKitSettings)=>new RoomServiceClient(s.url.replace(/^wss:/,"https:"),s.apiKey,s.apiSecret,{requestTimeout:8,failover:false});
export const egressClient=(s:LiveKitSettings)=>new EgressClient(s.url.replace(/^wss:/,"https:"),s.apiKey,s.apiSecret,{requestTimeout:12,failover:false});
export async function providerCall<T>(work:()=>Promise<T>):Promise<T>{
  try{return await work();}catch(error){
    if(error instanceof Error&&error.name==="AppError")throw error;
    return fail(502,"LiveKit could not complete this action. Check the connection and try again.");
  }
}
export function isMissing(error:unknown){return !!error&&typeof error==="object"&&"code" in error&&["not_found",5].includes(error.code as string);}
export async function verifyLiveKitConnection(s:LiveKitSettings){await providerCall(()=>roomClient(validateLiveKit(s)).listRooms());}
export function publishSources(mode:string,screen:string,publish:number,share:number,host:boolean){
  if(!publish)return [];
  const sources=[TrackSource.MICROPHONE];
  if(mode==="Video")sources.push(TrackSource.CAMERA);
  if(share&&screen!=="Disabled"&&(screen==="Everyone"||host))sources.push(TrackSource.SCREEN_SHARE,TrackSource.SCREEN_SHARE_AUDIO);
  return sources;
}
export async function participantToken(s:LiveKitSettings,room:string,identity:string,name:string,sources:TrackSource[],endsAt:string){
  const token=new AccessToken(s.apiKey,s.apiSecret,{identity,name,ttl:Math.max(1,Math.min(60,Math.floor((Date.parse(endsAt)-Date.now())/1000)))});
  // Host operations use authenticated Walshken endpoints. Never give browser roomAdmin or roomRecord grants.
  token.addGrant({room,roomJoin:true,canPublish:sources.length>0,canPublishSources:sources,canSubscribe:true,canPublishData:false,canUpdateOwnMetadata:false});
  return token.toJwt();
}
export function validateStorage(s:RecordingStorage){
  let url:URL;try{url=new URL(s.endpoint);}catch{return fail(400,"Enter the private bucket's S3 endpoint.");}
  const allowed=url.hostname==="ssggjxyexwkshtcypsaq.storage.supabase.co"||url.hostname==="ssggjxyexwkshtcypsaq.supabase.co"||
    /^(?:s3[.-][a-z0-9-]+\.amazonaws\.com|[a-z0-9]+\.r2\.cloudflarestorage\.com)$/.test(url.hostname);
  if(!allowed||url.protocol!=="https:"||url.username||url.password||url.port||url.search||url.hash||
    !["/","/storage/v1/s3"].includes(url.pathname))return fail(400,"Use this Supabase project's S3 endpoint, an AWS regional S3 endpoint, or an R2 account endpoint.");
  if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s.bucket)||!s.region||!s.accessKey||!s.secretKey)return fail(400,"Enter valid private bucket credentials.");
  return {...s,endpoint:url.toString().replace(/\/$/,"")};
}
export const storageClient=(s:RecordingStorage)=>new S3Client({endpoint:s.endpoint,region:s.region,forcePathStyle:true,
  credentials:{accessKeyId:s.accessKey,secretAccessKey:s.secretKey},maxAttempts:2,requestChecksumCalculation:"WHEN_REQUIRED"});
export async function recordingStorage(db:Db,requireEnabled=true){
  const row=await one<{configuration:string}>(db,`SELECT configuration FROM integrations WHERE id='recording-storage' ${requireEnabled?"AND enabled=1":""}`);
  if(!row)return fail(409,"Connect private recording storage in Integrations first.");
  return validateStorage(await decryptSettings("recording-storage",row.configuration) as RecordingStorage);
}
export async function verifyRecordingStorage(settings:RecordingStorage){
  const s=validateStorage(settings),client=storageClient(s),key=`walshken/verification/${crypto.randomUUID()}.txt`;
  try{
    await client.send(new HeadBucketCommand({Bucket:s.bucket}));
    await client.send(new PutObjectCommand({Bucket:s.bucket,Key:key,Body:"Walshken private recording storage verification",ContentType:"text/plain"}));
    const publicUrl=new URL(`${s.endpoint}/${s.bucket}/${key}`);
    const response=await fetch(publicUrl,{cache:"no-store",redirect:"error",signal:AbortSignal.timeout(8000)});
    if(![401,403,404].includes(response.status))return fail(400,"Recording storage must be private. Public access was not denied.");
    if(s.endpoint.includes("supabase.co")){
      const publicResponse=await fetch(`https://ssggjxyexwkshtcypsaq.supabase.co/storage/v1/object/public/${s.bucket}/${key}`,{cache:"no-store",redirect:"error",signal:AbortSignal.timeout(8000)});
      if(publicResponse.ok)return fail(400,"Disable public access for this Supabase bucket before connecting it.");
    }
  }catch(error){if(error instanceof Error&&error.name==="AppError")throw error;return fail(400,"Private storage verification failed. Check the endpoint, bucket and S3 credentials.");}
  finally{await client.send(new DeleteObjectCommand({Bucket:s.bucket,Key:key})).catch(()=>{});client.destroy();}
}
export async function deleteRecordingObject(db:Db,key:string){const s=await recordingStorage(db,false),client=storageClient(s);try{await client.send(new DeleteObjectCommand({Bucket:s.bucket,Key:key}));}finally{client.destroy();}}
export async function signedRecording(db:Db,key:string,seconds=60){const s=await recordingStorage(db,false),client=storageClient(s);try{return await getSignedUrl(client,new GetObjectCommand({Bucket:s.bucket,Key:key,ResponseContentDisposition:'attachment; filename="walshken-meeting-recording.mp4"'}),{expiresIn:seconds});}finally{client.destroy();}}
