import assert from "node:assert/strict";
import {createHmac,randomBytes,randomUUID} from "node:crypto";
import {copyFileSync,mkdirSync,mkdtempSync,rmSync,symlinkSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import { GET,POST } from "../app/api/customer/[action]/route.ts";
import { POST as webhook } from "../app/api/client-email/resend/route.ts";
import { passwordHash } from "../lib/walshken/passwords.ts";
import { database,digest,one,run } from "../lib/walshken/server.ts";
import { translateClient } from "../lib/walshken/client-locales.ts";

const root=process.cwd(), scratch=mkdtempSync(join(tmpdir(),"walshken-client-security-"));
process.on("exit",()=>rmSync(scratch,{recursive:true,force:true}));
symlinkSync(join(root,"drizzle"),join(scratch,"drizzle"),"dir");
mkdirSync(join(scratch,"supabase","migrations"),{recursive:true});
for(const file of ["20261125231710_staff_unit_memberships.sql","20261127090000_client_identity.sql","20261127090200_client_cases.sql","20261128105000_client_preferences_and_mfa.sql"]){
  copyFileSync(join(root,"supabase","migrations",file),join(scratch,"supabase","migrations",file));
}
process.chdir(scratch);
process.env.WALSHKEN_CLIENT_PORTAL_ENABLED="1";
process.env.WALSHKEN_INTEGRATION_KEY_V2=randomBytes(32).toString("base64");
const db=database(),origin="https://preview.walshken.test";
const person={id:randomUUID(), email:"client@walshken.test",password:randomBytes(18).toString("hex")};
const customer={cookie:"",ip:"192.0.2.10"}, otherBrowser={cookie:"",ip:"192.0.2.20"}, admin={cookie:"",ip:"192.0.2.30"};
await run(db,"INSERT INTO organizations(id,name,time_zone) VALUES('walshken','Walshken','UTC') ON CONFLICT DO NOTHING");
await run(db,"INSERT INTO customers(id,name,email,password_hash,email_verified_at) VALUES(?,?,?,?,?)",person.id,"Verified client",person.email,await passwordHash(person.password),new Date().toISOString());
await run(db,"INSERT INTO employees(id,org_id,employee_no,name,email,role) VALUES('admin-test','walshken','TEST','Test Admin','admin@walshken.test','super_admin')");
const staffToken=randomUUID()+randomUUID();
admin.cookie="walshken_session="+staffToken;
await run(db,"INSERT INTO sessions(id,employee_id,expires_at,agent) VALUES(?,?,?,'Preview browser')",await digest(staffToken),"admin-test",new Date(Date.now()+60_000).toISOString());
async function call(ctx, action, expected, data, query="") {
 const route=new Request(origin+"/api/customer/"+action+query,{method:data?"POST":"GET",headers:{
   origin,"x-vercel-forwarded-for":ctx.ip,cookie:ctx.cookie,...(data?{"Content-Type":"application/json"}:{})
 },body:data?JSON.stringify(data):undefined});
 const response=await (data?POST:GET)(route,{params:Promise.resolve({action})});
 const body=await response.json();
 assert.equal(response.status,expected,action+" "+JSON.stringify(body));
 const sent=response.headers.get("set-cookie");
 if(sent)ctx.cookie=sent.split(";")[0];
 return body;
}
const login={email:person.email,password:person.password};
await call(customer,"sign-in",200,login);
await call(otherBrowser,"sign-in",200,login);
assert.equal((await call(customer,"mfa",200)).enabled,false);
const setup=await call(customer,"mfa-setup",200,{password:person.password});
assert.match(setup.setupKey,/^[A-Z2-7]{32}$/);
function totp(encoded) {
 let bits=0,value=0;const secret=[];
 for(const char of encoded){value=(value<<5)|"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);bits+=5;if(bits>=8){bits-=8;secret.push((value>>>bits)&255);}}
 const count=Buffer.alloc(8);count.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30_000)));
 const mac=createHmac("sha1",Buffer.from(secret)).update(count).digest();
 return String((mac.readUInt32BE(mac.at(-1)&15)&0x7fffffff)%1_000_000).padStart(6,"0");
}
const first=totp(setup.setupKey);
const enrollment=await call(customer,"mfa-confirm",200,{password:person.password,code:first});
assert.equal(enrollment.recoveryCodes.length,8);
await call(otherBrowser,"status",401);
await call(customer,"sign-in",428,login);
await call(customer,"sign-in",401,{...login,mfaCode:first});
await call(customer,"sign-in",200,{...login,mfaCode:enrollment.recoveryCodes[0]});
assert.equal((await call(customer,"mfa",200)).recoveryCodesRemaining,7);
await call(otherBrowser,"sign-in",401,{...login,mfaCode:enrollment.recoveryCodes[0]});
await call(customer,"mfa-disable",200,{password:person.password,code:enrollment.recoveryCodes[1]});
await run(db,"UPDATE rate_limits SET expires_at=0 WHERE id=?",await digest("client-sign-in-address:"+await digest(person.email)));
await call(customer,"sign-in",200,login);
assert.equal((await call(customer,"mfa",200)).enabled,false);
console.log("PASS client authenticator setup, session revocation, TOTP replay rejection, single-use recovery, and disable");
await call(customer,"language-policy",401);
assert.equal((await call(customer,"locale",200,{locale:"ur"})).locale,"ur");
assert.notEqual(translateClient("ur","welcome",{name:"Client"}),translateClient("en","welcome",{name:"Client"}));
assert.deepEqual((await call(admin,"language-policy",200,{enabled:["fr"]})).enabled,["en","fr"]);
assert.equal((await call(customer,"locale",200)).locale,"en");
await call(customer,"locale",409,{locale:"ur"});
await call(customer,"account-access",401,{id:person.id,action:"Suspended",reason:"denied"});
await call(admin,"account-access",200,{id:person.id,action:"Suspended",reason:"Preview authorization test"});
await call(customer,"status",401);
await call(admin,"account-access",200,{id:person.id,action:"Restored",reason:"Preview review complete"});
customer.ip="192.0.2.40";
await call(customer,"sign-in",200,login);
console.log("PASS locale policy and user preference, scoped Admin suspension and session revocation");
const notice=randomUUID(), receipt=randomUUID(), secret=randomBytes(32);
process.env.WALSHKEN_CLIENT_RESEND_WEBHOOK_SECRET="whsec_"+secret.toString("base64");
const issued=new Date().toISOString();
await run(db,"INSERT INTO client_notifications(id,customer_id,type,title,body,href,dedupe_key,delivery,provider_receipt,created_at,available_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",notice,person.id,"appointment","Private appointment","Sign in","/customer/appointments","fixture","Accepted",receipt,issued,issued);
async function emailEvent(kind,date,signed=true){
 const key="msg_"+randomBytes(8).toString("hex"),stamp=String(Math.floor(Date.now()/1000));
 const raw=JSON.stringify({type:kind,created_at:date,data:{email_id:receipt}});
 const signature=createHmac("sha256",secret).update(key+"."+stamp+"."+raw).digest("base64");
 return webhook(new Request(origin+"/api/client-email/resend",{method:"POST",headers:{"svix-id":key,"svix-timestamp":stamp,"svix-signature":"v1,"+(signed?signature:"invalid")},body:raw}));
}
assert.equal((await emailEvent("email.delivered",issued,false)).status,401);
assert.equal((await emailEvent("email.delivered",issued)).status,200);
assert.equal((await emailEvent("email.delivery_delayed",new Date(Date.now()-60_000).toISOString())).status,200);
assert.equal((await one(db,"SELECT provider_delivery FROM client_notifications WHERE id=?",notice)).provider_delivery,"Delivered");
assert((await call(customer,"notifications",200)).notifications.some(e=>e.id===notice&&e.delivery==="Delivered"));
console.log("PASS signed delivery webhook, stale-event protection, and client-visible delivery status");
