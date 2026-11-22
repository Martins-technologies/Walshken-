import postgres from "postgres";
import { jwtVerify } from "jose";

// The existing Supabase project relays signed provider events to the approved Walshken deployment.
// Deployment access and the encryption key live in Vault, never in this function's source or responses.
const database=postgres(Deno.env.get("SUPABASE_DB_URL")!,{prepare:false,max:1,idle_timeout:5,connect_timeout:8});
const encode=new TextEncoder();
const bytes=(value:string)=>Uint8Array.from(atob(value),character=>character.charCodeAt(0));
const same=(a:string,b:string)=>{if(a.length!==b.length)return false;let result=0;for(let i=0;i<a.length;i++)result|=a.charCodeAt(i)^b.charCodeAt(i);return result===0;};
type Config={mode?:"production"|"preview";url:string;shareToken?:string;expiresAt?:number;encryptionKeyV2:string;cronSecret:string};
let cachedCookie={host:"",value:"",until:0};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
async function cookie(config:Config){
  if(config.mode==="production")return "";
  if(cachedCookie.host===config.url&&cachedCookie.until>Date.now())return cachedCookie.value;
  const url=new URL("/api/livekit/webhook",config.url);url.searchParams.set("_vercel_share",config.shareToken??"");
  const response=await fetch(url,{redirect:"manual",signal:AbortSignal.timeout(15000)});
  const value=response.headers.getSetCookie().map(item=>item.split(";")[0]).join("; ");
  if(!value)throw new Error("ReviewAccessUnavailable");
  cachedCookie={host:config.url,value,until:Date.now()+60000};return value;
}
async function body(request:Request){
  const reader=request.body?.getReader();if(!reader)throw new Error("MissingBody");
  let size=0;const chunks:Uint8Array[]=[];
  for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>262144){await reader.cancel();throw new Error("PayloadTooLarge");}chunks.push(part.value);}
  const output=new Uint8Array(size);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length;}return output;
}
Deno.serve(async request=>{
  if(!["POST","GET"].includes(request.method))return json({error:"Method not allowed"},405);
  const authorization=request.headers.get("authorization")??"";
  if(!authorization||authorization.length>4096)return json({error:"Unauthorized"},401);
  try{
    const [record]=await database`SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name IN ('walshken_calling_runtime_access','walshken_calling_review_access') ORDER BY CASE WHEN name='walshken_calling_runtime_access' THEN 0 ELSE 1 END LIMIT 1`;
    if(!record)return json({error:"Review access is not configured"},503);
    const config=JSON.parse(record.decrypted_secret) as Config;
    if(config.mode!=="production"&&(!config.expiresAt||config.expiresAt<=Date.now()))return json({error:"Review access expired"},503);
    if(!(config.mode==="production"?config.url==="https://walshken.vercel.app":/^https:\/\/walshken-[a-z0-9]+-martins-technologies\.vercel\.app$/.test(config.url)))return json({error:"Invalid review destination"},503);
    if(request.method==="GET"){
      let authorized=same(authorization,`Bearer ${config.cronSecret}`);
      const signed=authorization.match(/^ReviewCron (\d{10})\.([a-f0-9]{64})$/);
      if(signed&&Math.abs(Date.now()/1000-Number(signed[1]))<90){
        const key=await crypto.subtle.importKey("raw",encode.encode(config.cronSecret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
        const mac=new Uint8Array(await crypto.subtle.sign("HMAC",key,encode.encode(`walshken-calling-maintenance:${signed[1]}`)));
        authorized=same(signed[2],Array.from(mac,value=>value.toString(16).padStart(2,"0")).join(""));
      }
      if(!authorized)return json({error:"Unauthorized"},401);
      const response=await fetch(new URL("/api/livekit/maintenance",config.url),{headers:{authorization:`Bearer ${config.cronSecret}`,cookie:await cookie(config)},redirect:"error",signal:AbortSignal.timeout(50000)});
      return new Response(await response.text(),{status:response.status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
    }
    const raw=await body(request);
    const [integration]=await database`SELECT configuration FROM public.integrations WHERE id='livekit' AND enabled=1`;
    if(!integration)return json({error:"Calling is not configured"},503);
    const [version,iv,ciphertext]=String(integration.configuration).split(".");
    if(version!=="v2")return json({error:"Calling encryption is not configured"},503);
    const key=await crypto.subtle.importKey("raw",bytes(config.encryptionKeyV2),"AES-GCM",false,["decrypt"]);
    const clear=await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes(iv),additionalData:encode.encode("livekit")},key,bytes(ciphertext));
    const settings=JSON.parse(new TextDecoder().decode(clear));
    let claims;
    try{claims=(await jwtVerify(authorization.replace(/^Bearer\s+/i,""),encode.encode(settings.apiSecret),{issuer:settings.apiKey,algorithms:["HS256"],requiredClaims:["exp","sha256"]})).payload;}catch{return json({error:"Invalid LiveKit signature"},401);}
    const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",raw));
    const expected=btoa(String.fromCharCode(...digest));
    if(!same(String(claims.sha256??""),expected))return json({error:"Invalid LiveKit payload checksum"},401);
    const response=await fetch(new URL("/api/livekit/webhook",config.url),{method:"POST",headers:{authorization,"Content-Type":"application/webhook+json",cookie:await cookie(config)},body:raw,redirect:"error",signal:AbortSignal.timeout(50000)});
    return new Response(await response.text(),{status:response.status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
  }catch(error){
    const name=error instanceof Error?error.message:"UnknownError";
    if(name==="PayloadTooLarge")return json({error:"Payload too large"},413);
    if(name==="MissingBody")return json({error:"Payload required"},400);
    console.error("Calling review relay failed",error instanceof Error?error.name:"UnknownError");
    return json({error:"Calling review relay is temporarily unavailable"},503);
  }
});
