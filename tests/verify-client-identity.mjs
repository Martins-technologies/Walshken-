import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {copyFileSync,mkdirSync,mkdtempSync,rmSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {GET,POST} from "../app/api/customer/[action]/route.ts";
import {clientActor} from "../lib/walshken/customer.ts";
import {purgeExpiredClientChallenges} from "../lib/walshken/client-auth.ts";
import {notifyClient,processClientNotificationEmails} from "../lib/walshken/client-notifications.ts";
import {database,digest,encryptSettings,one,run} from "../lib/walshken/server.ts";

const root=process.cwd(), sandbox=mkdtempSync(join(tmpdir(),"walshken-client-identity-"));
symlinkSync(join(root,"drizzle"),join(sandbox,"drizzle"),"dir");
const migrations=join(sandbox,"supabase","migrations");
mkdirSync(migrations,{recursive:true});
for(const migration of ["20261125231710_staff_unit_memberships.sql","20261127090000_client_identity.sql","20261127090200_client_cases.sql"]){
 copyFileSync(join(root,"supabase","migrations",migration),join(migrations,migration));
}
process.chdir(sandbox);
process.on("exit",()=>rmSync(sandbox,{recursive:true,force:true}));
process.env.WALSHKEN_INTEGRATION_KEY=randomBytes(32).toString("base64");
process.env.WALSHKEN_CLIENT_EMAIL_ORIGIN="https://client.walshken.test";
const origin=process.env.WALSHKEN_CLIENT_EMAIL_ORIGIN;
const id=randomBytes(5).toString("hex");
const browser=(number)=>({cookie:"",ip:`192.0.2.${number}`});
const old=browser(60),first=browser(61),second=browser(62),peer=browser(63);
const credential=(address,name="Jordan reviewer")=>({name,email:`${address}-${id}@walshken.test`,password:randomBytes(18).toString("hex")});
const account=credential("current"),legacy=credential("legacy"),other=credential("other","Another reviewer");
const db=database();
async function request(action,expected,body,context=first,source=origin) {
 const headers={origin:source,"x-vercel-forwarded-for":context?.ip??"192.0.2.250","user-agent":"Mozilla/5.0 Macintosh Chrome/136",
   ...(body?{"content-type":"application/json"}:{}),...(context?.cookie?{cookie:context.cookie}:{})};
 const req=new Request(origin+"/api/customer/"+action,{method:body?"POST":"GET",headers,body:body?JSON.stringify(body):undefined});
 const params={params:Promise.resolve({action})};
 const res=await (body?POST:GET)(req,params),data=await res.json();
 assert.equal(res.status,expected,action+" / "+JSON.stringify(data));
 assert.match(res.headers.get("cache-control"),/no-store/);
 if (res.headers.get("set-cookie")&&context) {
  context.cookie=res.headers.get("set-cookie").split(";")[0];
  assert.match(res.headers.get("set-cookie"),/HttpOnly; SameSite=Strict; Secure/);
 }
 return data;
}
const registration = (person)=>({...person,confirmPassword:person.password});
await request("sign-up",201,registration(legacy),old);
process.env.WALSHKEN_CLIENT_PORTAL_ENABLED="1";
await request("status",401,undefined,old);
await request("sign-up",503,registration(account));
assert.equal(await one(db,"SELECT id FROM customers WHERE email=?",account.email),null);
await run(db,"INSERT INTO integrations(id,configuration,enabled) VALUES('resend',?,1)",
 await encryptSettings("resend",{apiKey:"re_test_client_mocked",from:"staff@notify.walshken.test"}));

const originalFetch=globalThis.fetch, outgoing=[];
let providerStatus=200;
globalThis.fetch=async(url,options)=>{
 assert.equal(url,"https://api.resend.com/emails");
 const data=JSON.parse(options.body);
 outgoing.push({id:options.headers["Idempotency-Key"],...data});
 return Response.json(providerStatus===200?{id:`fixture_${outgoing.length}`}:{message:"unavailable"},{status:providerStatus});
};
const codeFor=(mailbox)=>[...outgoing].reverse().find(mail=>mail.to[0]===mailbox&&/Enter \d{6}/.test(mail.text)).text.match(/Enter (\d{6})/)[1];
const beyond=(milliseconds)=>new Date(Date.now()+milliseconds).toISOString();
try {
 await request("sign-up",403,registration(account),first,"https://different.walshken.test");
 providerStatus=503;
 await request("sign-up",503,registration(account));
 await request("profile",401);
 providerStatus=200;
 const signup=await request("sign-up",202,registration(account));
 const enrollment=await one(db,"SELECT * FROM client_auth_challenges WHERE id=?",signup.challengeId);
 assert.ok(enrollment.pending_password_hash&&enrollment.pending_password_hash!==account.password);
 assert.notEqual(enrollment.code_digest,codeFor(account.email));
 assert.equal(await one(db,"SELECT id FROM customers WHERE email=?",account.email),null);
 await request("sign-in",401,account);
 await request("resend",429,{challengeId:signup.challengeId});
 let wrong=codeFor(account.email)==="000000"?"123456":"000000";
 for(let attempt=0;attempt<6;attempt++)await request("verify",400,{challengeId:signup.challengeId,code:wrong});
 assert.equal((await one(db,"SELECT attempts FROM client_auth_challenges WHERE id=?",signup.challengeId)).attempts,6);
 await request("verify",400,{challengeId:signup.challengeId,code:codeFor(account.email)});
 await run(db,"UPDATE client_auth_challenges SET resend_after=? WHERE id=?",beyond(-100),signup.challengeId);
 const previousCode=codeFor(account.email);
 await request("resend",202,{challengeId:signup.challengeId});
 if (previousCode!==codeFor(account.email))await request("verify",400,{challengeId:signup.challengeId,code:previousCode});
 await request("verify",200,{challengeId:signup.challengeId,code:codeFor(account.email)});
 await request("verify",400,{challengeId:signup.challengeId,code:codeFor(account.email)},second);
 const customer=await request("status",200);
 assert.equal(customer.verified,true);
 assert.equal((await one(db,"SELECT pending_password_hash FROM client_auth_challenges WHERE id=?",signup.challengeId)).pending_password_hash,null);

 const login = await request("sign-in",200,legacy,old);assert.equal(login.verified,false);
 await request("profile",403,undefined,old);
 const challenge=await request("verification",202,{},old);
 await request("verify",401,{challengeId:challenge.challengeId,code:codeFor(legacy.email)},first);
 await request("verify",200,{challengeId:challenge.challengeId,code:codeFor(legacy.email)},old);
 assert.equal((await request("status",200,undefined,old)).verified,true);
 const secondSignup=await request("sign-up",202,registration(other),peer);
 await run(db,"UPDATE client_auth_challenges SET expires_at=? WHERE id=?",beyond(-100),secondSignup.challengeId);
 await request("verify",400,{challengeId:secondSignup.challengeId,code:codeFor(other.email)},peer);
 await run(db,"UPDATE client_auth_challenges SET resend_after=? WHERE id=?",beyond(-100),secondSignup.challengeId);
 await request("resend",202,{challengeId:secondSignup.challengeId},peer);
 await request("verify",200,{challengeId:secondSignup.challengeId,code:codeFor(other.email)},peer);
 const otherId=(await request("status",200,undefined,peer)).id;

 const isolated=await request("profile",200);assert.equal(isolated.version,0);
 await request("profile",409,{version:0,email:other.email});
 await request("profile",400,{version:0,dob:"2090-01-01"});
 await request("profile",400,{version:0,passportNumber:"A12345"});
 const details={version:0,name:"Jordan Verified",dob:"1992-04-10",phone:"+1 780 555 0101",address:"Private fixture address",
   countryOfBirth:"CA",countryOfResidence:"CA",citizenships:["CA","IN","CA"],language:"English",passportNumber:"QA00001234",passportCountry:"CA"};
 await request("profile",200,details);
 const profile=await request("profile",200);
 assert.equal(profile.completion,100);
 assert.deepEqual(profile.profile.citizenships,["CA","IN"]);
 assert(profile.history[0].fields.includes("passportNumber"));
 const stored=await one(db,"SELECT encrypted_details FROM client_profiles WHERE customer_id=?",customer.id);
 assert(!stored.encrypted_details.includes(details.passportNumber));
 assert(!stored.encrypted_details.includes(details.address));
 await request("profile",409,details);
 await request("profile-verification",401,{id:customer.id,version:1,fields:["name"],reason:"Test denied access"});
 const administrator=browser(64),staffId=randomUUID(),staffToken=randomUUID()+randomUUID();
 await run(db,"INSERT INTO organizations(id,name) VALUES ('walshken','Walshken') ON CONFLICT(id) DO NOTHING");
 await run(db,"INSERT INTO employees(id,org_id,employee_no,name,email,role) VALUES (?,'walshken',?,'Authorized Reviewer',?,'super_admin')",
  staffId,"COMPANY-"+id,credential("company").email);
 await run(db,"INSERT INTO sessions(id,employee_id,expires_at,agent) VALUES (?,?,?,'identity-test')",await digest(staffToken),staffId,beyond(3600_000));
 administrator.cookie="walshken_session="+staffToken;
 await request("profile-verification",200,{id:customer.id,version:1,fields:["name"],reason:"Verified against approved identity evidence"},administrator);
 await request("profile",403,{version:2,name:"Changed legal name"});
 assert.equal((await request("profile",200,undefined,peer)).profile.passportNumber,"");

 await request("notification-preferences",200,{email:true});
 const notice = {type:"case",title:"Update available",body:"Check your case.",href:"/customer/cases",dedupeKey:"case:fixture"};
 const noticeId = await notifyClient(db,customer.id,notice);
 assert(noticeId);assert.equal(await notifyClient(db,customer.id,notice),null);
 const otherNotice=await notifyClient(db,otherId,notice);
 const announcement={id:customer.id,reference:randomUUID(),title:"A company announcement",body:"Private fixture announcement details"};
 await request("announcement",401,announcement);
 await request("announcement",404,{...announcement,case:randomUUID()},administrator);
 await request("announcement",201,announcement,administrator);
 await request("announcement",200,announcement,administrator);
 await request("announcement",409,{...announcement,title:"Changed title"},administrator);
 assert.equal((await request("notifications",200)).notifications.filter(item=>item.type==="announcement").length,1);
 assert.equal((await request("notifications",200,undefined,peer)).notifications.filter(item=>item.type==="announcement").length,0);
 const caseId=randomUUID();
 await run(db,`INSERT INTO client_cases(id,org_id,customer_id,reference,title,service,country,created_at,updated_at)
  VALUES(?,'walshken',?,?,'Synthetic client case','immigration','CA',?,?)`,caseId,customer.id,"CASE-"+id,beyond(0),beyond(0));
 await request("announcement",404,{...announcement,id:otherId,case:caseId,reference:randomUUID()},administrator);
 await request("announcement",201,{...announcement,case:caseId,reference:randomUUID()},administrator);
 assert((await request("notifications",200)).notifications.some(item=>item.type==="announcement"&&item.href.endsWith(caseId)));
 await request("notification-read",404,{id:otherNotice});
 assert(!(await request("notifications",200)).notifications.some(item=>item.id===otherNotice));
 await request("notification-read",200,{id:noticeId});
 assert((await request("notifications",200)).notifications.find(item=>item.id===noticeId).readAt);
 providerStatus=429;
 const retry=await processClientNotificationEmails(db,15_000);
 assert(retry.retry>0);
 await run(db,"UPDATE client_notifications SET available_at=? WHERE delivery='Retry'",beyond(-100));
 providerStatus=200;
 assert((await processClientNotificationEmails(db,15_000)).accepted>0);
 const securityOut=outgoing.find(row=>row.id.startsWith("walshken-client-notice/"));
 assert(securityOut&&!securityOut.text.includes(details.passportNumber));
 assert(!outgoing.some(row=>row.text.includes(announcement.body)));

 await request("sign-in",200,account,second);
 const active=await request("sessions",200);
 assert.equal(active.sessions.filter(row=>!row.endedAt).length,2);
 const secondSession=(await request("status",200,undefined,second)).sessionId;
 await request("session-revoke",404,{id:(await request("status",200,undefined,peer)).sessionId});
 await request("session-revoke",200,{id:secondSession});
 await request("status",401,undefined,second);
 await run(db,"UPDATE customer_sessions SET reauthenticated_at=? WHERE session_ref=?",beyond(-20*60_000),customer.sessionId);
 const recentRequest=()=>new Request(origin+"/api/customer/status",{headers:{cookie:first.cookie}});
 await assert.rejects(()=>clientActor(db,recentRequest(),{recent:true}),/Confirm your password/);
 await request("reauthenticate",200,{password:account.password});
 assert.equal((await clientActor(db,recentRequest(),{recent:true})).id,customer.id);
 await run(db,"UPDATE customer_sessions SET last_seen_at=?,idle_expires_at=? WHERE session_ref=?",beyond(-10*60_000),beyond(5*60_000),customer.sessionId);
 await request("status",200);
 assert(Date.parse((await one(db,"SELECT idle_expires_at FROM customer_sessions WHERE session_ref=?",customer.sessionId)).idle_expires_at)<Date.now()+6*60_000);
 await request("activity",200,{});
 assert(Date.parse((await one(db,"SELECT idle_expires_at FROM customer_sessions WHERE session_ref=?",customer.sessionId)).idle_expires_at)>Date.now()+28*60_000);

 const changed=credential("replacement").email;
 const change=await request("email-change",202,{newEmail:changed,currentPassword:account.password});
 await request("email-change-verify",200,{challengeId:change.challengeId,code:codeFor(changed)});
 assert.equal((await request("profile",200)).profile.email,changed);
 const reset=await request("password-reset",202,{email:changed},second);
 const resetPassword=" "+randomBytes(18).toString("hex")+" ";
 const priorCookie=first.cookie;
 await request("password-reset-confirm",200,{challengeId:reset.challengeId,code:codeFor(changed),password:resetPassword,confirmPassword:resetPassword},second);
 await request("password-reset-confirm",400,{challengeId:reset.challengeId,code:codeFor(changed),password:resetPassword,confirmPassword:resetPassword},second);
 await request("status",401,undefined,{...first,cookie:priorCookie});
 await request("sign-in",401,{email:changed,password:account.password});
 await request("sign-in",200,{email:changed,password:resetPassword});
 await request("reauthenticate",200,{password:resetPassword});
 const storedSession=await one(db,"SELECT id FROM customer_sessions WHERE id=?",await digest(first.cookie.split("=")[1]));
 assert(storedSession);
 assert(!JSON.stringify(await request("sessions",200)).includes(storedSession.id));
 await run(db,"UPDATE customer_sessions SET idle_expires_at=? WHERE id=?",beyond(-10),storedSession.id);
 await request("status",401);
 await run(db,"UPDATE customers SET suspended_at=? WHERE id=?",beyond(-100),otherId);
 await request("status",401,undefined,peer);
 await request("sign-in",401,other,peer);
 let resetWithoutAccount=await request("password-reset",202,{email:credential("unknown").email},second);
 assert.notEqual(resetWithoutAccount.challengeId,undefined);
 assert(!/Enter \d{6}/.test(outgoing.at(-1).text));
 await run(db,"UPDATE client_auth_challenges SET workflow_expires_at=? WHERE id=?",beyond(-2*60*60_000),signup.challengeId);
 assert.equal(await purgeExpiredClientChallenges(db),1);
 assert.equal(await one(db,"SELECT id FROM client_auth_challenges WHERE id=?",signup.challengeId),null);
 console.log("PASS verified client registration, provider failures, OTP expiry and resend, onboarding legacy accounts, encrypted profiles and locked fields, notification privacy/retry, scoped sessions and idle/re-authentication, email change, reset, and closure");
} finally {
 globalThis.fetch=originalFetch;
}
