import {randomInt,timingSafeEqual} from "node:crypto";
import {passwordHash,passwordMatches} from "./passwords";
import {clientPortalEnabled} from "./client-feature";
import {clientEmailOrigin,requireClientEmailSender,sendClientEmail,type ClientEmailSender} from "./client-email";
import {recordClientProfileChange} from "./client-profile";
import {
  clientActor,clientAddress,clientPrivateDigest,clientSecurityEvent,clientSessionResponse,customerToken,endClientSessions,
  issueClientSession,rawClientSession,validClientId,type Customer,
} from "./client-sessions";
import {digest,email,fail,id,json,now,one,run,str,throttle,type Db} from "./server";

type Purpose = "Registration"|"Verification"|"Password reset"|"Email change";
type Account = Customer & {password_hash:string;email_verified_at:string|null;suspended_at:string|null};
type Challenge = {
  id:string;purpose:Purpose;customer_id:string|null;target_email:string;pending_name:string|null;pending_password_hash:string|null;
  account_password_digest:string|null;code_digest:string;expires_at:string;workflow_expires_at:string;resend_after:string;attempts:number;
  generation:number;delivery:string;consumed_at:string|null;
};
const otpLife = 10 * 60_000;
const workflowLife = 30 * 60_000;
const resendMs = 60_000;
const soon = (ms:number) => new Date(Date.now()+ms).toISOString();
const getCode = () => randomInt(1_000_000).toString().padStart(6,"0");
const otpDigest = (challenge:string,generation:number,code:string) => clientPrivateDigest("client-otp",JSON.stringify([challenge,generation,code]));
const accountDigest = (account:Account) => clientPrivateDigest("client-credential-state",JSON.stringify([account.password_hash,account.email]));
const accountLookup = (db:Db,mailbox:string) => one<Account>(db,"SELECT * FROM customers WHERE email=?",mailbox);
const activeAccount = (db:Db,customerId:string) => one<Account>(db,"SELECT * FROM customers WHERE id=? AND suspended_at IS NULL FOR UPDATE",customerId);
const genericSignIn = "Email or password is incorrect.";

export function readClientPassword(value:unknown) {
  if(typeof value!=="string"||!value||value.length>160)return fail(400,"Enter a valid password.");
  return value;
}
export function makeClientPassword(value:unknown,confirmation:unknown) {
  const password = readClientPassword(value);
  if(password.length<12)return fail(400,"Use a password of at least 12 characters.");
  if(password!==confirmation)return fail(400,"The passwords must match.");
  return password;
}

function challengeSummary(row:Pick<Challenge,"id"|"expires_at"|"resend_after">) {
  return json({ok:true,challengeId:row.id,expiresAt:row.expires_at,resendAfter:row.resend_after,
    message:"Check your email for the next step."},202);
}

async function deliverChallenge(db:Db,settings:ClientEmailSender,row:Challenge,code:string,eligible:boolean) {
  const origin = clientEmailOrigin();
  const title = row.purpose==="Password reset"?"Reset your Walshken password"
    : row.purpose==="Email change"?"Confirm your new Walshken email address":"Verify your Walshken email";
  const text = eligible
    ? `Enter ${code} in the Walshken window where you made the request. It expires in 10 minutes. If you did not start this request, ignore this message.`
    : row.purpose==="Registration"?"This address already has a Walshken client account. Use Sign in, or Reset password if you need access."
      :"If you use another email address for your client account, request a reset with that address. Contact Walshken if you need support.";
  const sent = await sendClientEmail(settings,row.target_email,{subject:title,text:origin?`${text}\n\n${origin}/customer/sign-in`:text},`walshken-client-auth/${row.id}/${row.generation}`);
  await run(db,`UPDATE client_auth_challenges SET delivery=?,provider_receipt=? WHERE id=? AND generation=? AND consumed_at IS NULL`,
    !sent.receipt?"Failed":eligible?"Accepted":"Suppressed",sent.receipt,row.id,row.generation);
  if (!sent.receipt) return fail(503,"Walshken’s email provider could not accept the message. Try again shortly or contact support.");
  return challengeSummary(row);
}
async function openChallenge(db:Db,request:Request,purpose:Purpose,mailbox:string,options:{
  account?:Account|null; name?:string; password?:string; eligible:boolean;
}) {
  await throttle(db,`client-code-source:${await digest(clientAddress(request))}`,20,3_600_000);
  await throttle(db,`client-code-address:${await digest(mailbox)}:${purpose}`,5,3_600_000);
  const sender = await requireClientEmailSender(db);
  const code = getCode(), target = id(), stamp = now();
  const row:Challenge = {
    id:target,purpose,customer_id:options.account?.id??null,target_email:mailbox,pending_name:options.name??null,pending_password_hash:options.password??null,
    account_password_digest:options.account?accountDigest(options.account):null,code_digest:otpDigest(target,1,code),
    expires_at:soon(otpLife),workflow_expires_at:soon(workflowLife),resend_after:soon(resendMs),attempts:0,generation:1,delivery:"Pending",consumed_at:null,
  };
  await run(db,`INSERT INTO client_auth_challenges(id,purpose,customer_id,target_email,pending_name,pending_password_hash,account_password_digest,
    code_digest,created_at,expires_at,workflow_expires_at,resend_after,delivery) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.id,row.purpose,row.customer_id,row.target_email,row.pending_name,row.pending_password_hash,row.account_password_digest,
    row.code_digest,stamp,row.expires_at,row.workflow_expires_at,row.resend_after,row.delivery);
  return deliverChallenge(db,sender,row,code,options.eligible);
}

export async function registerClient(db:Db,request:Request,data:Record<string,unknown>) {
  const mailbox=email(data.email),name=str(data.name,"full legal name",100),password=makeClientPassword(data.password,data.confirmPassword);
  await throttle(db,`client-registration-source:${await digest(clientAddress(request))}`,10,3_600_000);
  const [account,hash] = await Promise.all([accountLookup(db,mailbox),passwordHash(password)]);
  return openChallenge(db,request,"Registration",mailbox,{eligible:!account,name:account?undefined:name,password:account?undefined:hash});
}

export async function signInClient(db:Db,request:Request,data:Record<string,unknown>) {
  const mailbox=email(data.email),password=readClientPassword(data.password);
  await throttle(db,`client-sign-in-source:${await digest(clientAddress(request))}`,35,300_000);
  await throttle(db,`client-sign-in-address:${await digest(mailbox)}`,6,300_000);
  const account = await accountLookup(db,mailbox);
  if (!await passwordMatches(password,account?.password_hash)||!account||account.suspended_at) return fail(401,genericSignIn);
  return db.transaction(async tx=>{
    const current = await activeAccount(tx,account.id);
    if (!current || current.password_hash!==account.password_hash || current.email!==account.email) return fail(401,genericSignIn);
    const token=await issueClientSession(tx,request,current,!!current.email_verified_at);
    return clientSessionResponse(request,token,{ok:true,verified:!!current.email_verified_at});
  });
}

export async function requestClientVerification(db:Db,request:Request) {
  const session = await rawClientSession(db,customerToken(request.headers.get("cookie")),true);
  if (!session) return fail(401,"Sign in to request email verification.");
  if (session.verifiedAt) return json({ok:true,verified:true,message:"Your email is already verified."});
  const account=await accountLookup(db,session.email);
  if (!account || account.id!==session.id || account.suspended_at) return fail(401,"Sign in to request email verification.");
  return openChallenge(db,request,"Verification",account.email,{account,eligible:true});
}

export async function requestClientPasswordReset(db:Db,request:Request,data:Record<string,unknown>) {
  const mailbox=email(data.email),account=await accountLookup(db,mailbox);
  const eligible = !!account && !account.suspended_at;
  return openChallenge(db,request,"Password reset",mailbox,{account:eligible?account:null,eligible});
}

export async function requestClientEmailChange(db:Db,request:Request,data:Record<string,unknown>) {
  const actor = await clientActor(db,request,{touch:true}),mailbox=email(data.newEmail),password=readClientPassword(data.currentPassword);
  if (mailbox===actor.email) return fail(400,"Enter a different email address.");
  await throttle(db,`client-email-change:${actor.id}`,5,900_000);
  const account = await accountLookup(db,actor.email);
  if (!account||account.id!==actor.id||!await passwordMatches(password,account.password_hash)) return fail(401,"Current password is incorrect.");
  if (await accountLookup(db,mailbox)) return fail(409,"That email address cannot be used for this account.");
  return openChallenge(db,request,"Email change",mailbox,{account,eligible:true});
}

export async function resendClientChallenge(db:Db,request:Request,data:Record<string,unknown>) {
  const target = str(data.challengeId,"verification request",80);
  if(!validClientId.test(target))return fail(404,"Verification request unavailable.");
  await throttle(db,`client-code-source:${await digest(clientAddress(request))}`,20,3_600_000);
  const settings=await requireClientEmailSender(db);
  const code=getCode();
  const challenge=await db.transaction(async tx=>{
    const old=await one<Challenge>(tx,"SELECT * FROM client_auth_challenges WHERE id=? FOR UPDATE",target);
    if(!old||old.consumed_at||old.workflow_expires_at<=now()||old.generation>=4)return fail(409,"Start a new verification request.");
    if(old.resend_after>now())return fail(429,"Wait a minute before requesting another code.");
    if(old.purpose==="Verification"||old.purpose==="Email change"){
      const session=await rawClientSession(tx,customerToken(request.headers.get("cookie")));
      if(!session||session.id!==old.customer_id)return fail(401,"Sign in to request a new code.");
    }
    const account=old.customer_id ? await one<Account>(tx,"SELECT * FROM customers WHERE id=? AND suspended_at IS NULL",old.customer_id) : null;
    const eligible=old.purpose==="Registration" ? !!old.pending_password_hash && !await accountLookup(tx,old.target_email)
      : !!account && old.account_password_digest===accountDigest(account);
    const generation=old.generation+1;
    const updated=await one<Challenge>(tx,`UPDATE client_auth_challenges SET generation=?,code_digest=?,expires_at=?,resend_after=?,attempts=0,
      delivery='Pending',provider_receipt=NULL WHERE id=? RETURNING *`,
      generation,otpDigest(target,generation,code),[soon(otpLife),old.workflow_expires_at].sort()[0],soon(resendMs),target);
    return {row:updated!,eligible};
  });
  return deliverChallenge(db,settings,challenge.row,code,challenge.eligible);
}

export async function finishClientChallenge(db:Db,request:Request,action:"verify"|"password-reset-confirm"|"email-change-verify",data:Record<string,unknown>) {
  const target=str(data.challengeId,"verification request",80),code=str(data.code,"six-digit code",6);
  if (!validClientId.test(target)||!/^\d{6}$/.test(code)) return fail(400,"Enter a valid six-digit code.");
  await throttle(db,`client-code-check:${await digest(clientAddress(request))}`,80,300_000);
  const reset=action==="password-reset-confirm" ? makeClientPassword(data.password,data.confirmPassword) : null;
  const cookie=customerToken(request.headers.get("cookie"));
  const password=reset?await passwordHash(reset):null;
  const result = await db.transaction(async tx=>{
    const row=await one<Challenge>(tx,"SELECT * FROM client_auth_challenges WHERE id=? FOR UPDATE",target);
    const permitted=action==="verify"?["Registration","Verification"]:action==="password-reset-confirm"?["Password reset"]:["Email change"];
    if(!row||!permitted.includes(row.purpose)||row.delivery!=="Accepted"||row.consumed_at||row.expires_at<=now()||row.attempts>=6)return null;
    const expected=Buffer.from(otpDigest(row.id,row.generation,code),"hex");
    const stored=Buffer.from(row.code_digest,"hex");
    if(stored.length!==expected.length||!timingSafeEqual(stored,expected)){
      await run(tx,"UPDATE client_auth_challenges SET attempts=attempts+1 WHERE id=?",row.id);
      return null;
    }
    const consume=()=>run(tx,"UPDATE client_auth_challenges SET consumed_at=?,pending_name=NULL,pending_password_hash=NULL WHERE id=?",now(),row.id);
    if(row.purpose==="Registration"){
      if(!row.pending_name||!row.pending_password_hash)return null;
      const account=await one<Customer>(tx,`INSERT INTO customers(id,name,email,password_hash,email_verified_at)
        VALUES (?,?,?,?,?) ON CONFLICT(email) DO NOTHING RETURNING id,name,email`,id(),row.pending_name,row.target_email,row.pending_password_hash,now());
      await consume();
      if(!account)return null;
      await clientSecurityEvent(tx,account.id,null,"Email verified",{title:"Your Walshken account is ready",body:"Your email address has been verified and your client account is active."});
      return {token:await issueClientSession(tx,request,account,false),message:"Your email has been verified."};
    }
    if(!row.customer_id)return null;
    const account=await activeAccount(tx,row.customer_id);
    if(!account||row.account_password_digest!==accountDigest(account))return null;
    if(row.purpose==="Password reset"){
      if(!password||!reset||await passwordMatches(reset,account.password_hash))return fail(400,"Choose a different password.");
      await run(tx,"UPDATE customers SET password_hash=?,email_verified_at=COALESCE(email_verified_at,?) WHERE id=?",password,now(),account.id);
      await consume();
      await endClientSessions(tx,account.id);
      await clientSecurityEvent(tx,account.id,null,"Password reset",{title:"Your password was reset",body:"The password was reset and the previous account sessions were signed out."});
      return {token:"",message:"Password changed. Sign in with your new password."};
    }
    const session=await rawClientSession(tx,cookie);
    if(!session||session.id!==account.id||row.purpose==="Email change"&&!session.verifiedAt)return fail(401,"Sign in to finish the verification.");
    const stamp=now();
    if(row.purpose==="Verification"){
      if(account.email!==row.target_email)return null;
      await run(tx,"UPDATE customers SET email_verified_at=COALESCE(email_verified_at,?) WHERE id=?",stamp,account.id);
      await clientSecurityEvent(tx,account.id,session.sessionId,"Email verified",{title:"Email address confirmed",body:"Verification for your Walshken client account is complete."});
    } else {
      if (await accountLookup(tx,row.target_email)) return fail(409,"That email address cannot be used for this account.");
      await run(tx,"UPDATE customers SET email=?,email_verified_at=? WHERE id=?",row.target_email,stamp,account.id);
      await recordClientProfileChange(tx,account.id,"Client","Email changed",["email"],{previous:account.email,current:row.target_email});
      await clientSecurityEvent(tx,account.id,session.sessionId,"Email address changed",{title:"Your sign-in email address changed",body:"The new address has been verified. Contact Walshken if you did not make the change.",recipient:account.email});
      account.email=row.target_email;
    }
    await consume();
    await endClientSessions(tx,account.id);
    return {token:await issueClientSession(tx,request,account,false),message:"Your email has been verified."};
  });
  if(!result)return fail(400,"This code is invalid or expired. Request a new code to continue.");
  return clientSessionResponse(request,result.token,{ok:true,verified:true,message:result.message});
}

export async function purgeExpiredClientChallenges(db:Db) {
  if (!clientPortalEnabled()) return 0;
  const removed=await run(db,`DELETE FROM client_auth_challenges WHERE id IN (
    SELECT id FROM client_auth_challenges WHERE workflow_expires_at<? ORDER BY workflow_expires_at,id LIMIT 200)`,
    new Date(Date.now()-3_600_000).toISOString());
  return removed.count;
}
