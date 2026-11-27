import {createHmac,timingSafeEqual} from "node:crypto";
import {clientPortalEnabled} from "./client-feature";
import {fail,json,run,type Db} from "./server";

const deliveryStates={
  "email.delivered":"Delivered","email.delivery_delayed":"Delayed","email.bounced":"Bounced",
  "email.complained":"Complained","email.failed":"Failed",
} as const;

export async function recordClientEmailEvent(db:Db,request:Request){
  if(!clientPortalEnabled())return fail(404,"Client Portal is unavailable.");
  const secret=process.env.WALSHKEN_CLIENT_RESEND_WEBHOOK_SECRET??"";
  if(!/^whsec_[A-Za-z0-9+/=]+$/.test(secret))return fail(503,"The email events webhook is unconfigured.");
  const id=request.headers.get("svix-id")??"", signed=request.headers.get("svix-signature")??"", stamp=request.headers.get("svix-timestamp")??"";
  if(!/^[A-Za-z0-9_-]{1,200}$/.test(id)||!/^\d{10}$/.test(stamp)||Math.abs(Date.now()/1000-Number(stamp))>300||signed.length>1300)return fail(401,"Email event signature is invalid.");
  const advertised=Number(request.headers.get("content-length")??0);
  if(advertised>65536)return fail(413,"Email event exceeds its size limit.");
  const body=await request.text();
  if(Buffer.byteLength(body)>65536)return fail(413,"Email event exceeds its size limit.");
  const expected=createHmac("sha256",Buffer.from(secret.slice(6),"base64")).update(id+"."+stamp+"."+body).digest();
  const accepted=signed.split(" ").some(value=>{
    if(!value.startsWith("v1,"))return false;
    const got=Buffer.from(value.slice(3),"base64");
    return got.length===expected.length&&timingSafeEqual(got,expected);
  });
  if(!accepted)return fail(401,"Email event signature is invalid.");
  let value;
  try{value=JSON.parse(body);}catch{return fail(400,"Email event data is invalid.");}
  const state=Object.hasOwn(deliveryStates,value?.type) ? deliveryStates[value.type as keyof typeof deliveryStates] : null;
  if(!state)return json({ok:true});
  const receipt=value?.data?.email_id,created=new Date(value?.created_at??"");
  if(typeof receipt!=="string"||!/^[A-Za-z0-9_-]{1,200}$/.test(receipt)||!Number.isFinite(created.getTime()))return fail(400,"Email event record is invalid.");
  const time=created.toISOString();
  await run(db,"UPDATE client_notifications SET provider_delivery=?,provider_delivered_at=? WHERE provider_receipt=? AND (provider_delivered_at IS NULL OR provider_delivered_at<?)",
    state,time,receipt,time);
  return json({ok:true});
}
