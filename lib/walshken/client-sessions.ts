import {createHmac,randomBytes} from "node:crypto";
import {passwordMatches} from "./passwords";
import {clientPortalEnabled} from "./client-feature";
import {notifyClient} from "./client-notifications";
import {all,cookieValue,digest,fail,id,json,now,one,run,sessionSet,throttle,type Db} from "./server";

export type Customer = {id:string; name:string; email:string};
export type ClientActor = Customer & {sessionId:string; verifiedAt:string};
export type ClientSession = Customer & {sessionId:string; sessionHash:string; verifiedAt:string|null; lastSeenAt:string; authenticatedAt:string|null};
export const customerCookie = "walshken_customer";
export const customerSessionSeconds = 43_200;
const idleMs = 30 * 60_000;
const recentMs = 15 * 60_000;
export const validCustomerToken = /^[0-9a-f]{64}$/;
export const validClientId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function clientPrivateDigest(scope:string,value:string) {
  const secret = process.env.WALSHKEN_CLIENT_OTP_KEY || process.env.WALSHKEN_INTEGRATION_KEY_V2 || process.env.WALSHKEN_INTEGRATION_KEY;
  if (!secret || secret.length<32) return fail(503,"Client account verification needs a protected server key.");
  return createHmac("sha256",secret).update(scope).update("\x00").update(value).digest("hex");
}
export function clientAddress(request:Request) {
  return (request.headers.get("x-vercel-forwarded-for") ?? "local").split(",")[0].trim().slice(0,72);
}
export function customerToken(header:string|null) {
  return cookieValue(header,customerCookie);
}
export async function rawClientSession(db:Db,token:string,touch=false) {
  if (!validCustomerToken.test(token)) return null;
  const stamp = now(), tokenHash = await digest(token);
  const session = await one<ClientSession>(db,`SELECT c.id,c.name,c.email,c.email_verified_at AS "verifiedAt",
    s.session_ref AS "sessionId",s.id AS "sessionHash",s.last_seen_at AS "lastSeenAt",s.reauthenticated_at AS "authenticatedAt"
    FROM customers c JOIN customer_sessions s ON s.customer_id=c.id
    WHERE s.id=? AND s.session_ref IS NOT NULL AND s.ended_at IS NULL AND s.idle_expires_at>? AND s.expires_at>? AND c.suspended_at IS NULL`,tokenHash,stamp,stamp);
  if (touch && session && Date.now()-Date.parse(session.lastSeenAt)>=60_000) {
    const result=await run(db,`UPDATE customer_sessions SET last_seen_at=?,idle_expires_at=?
      WHERE id=? AND customer_id=? AND ended_at IS NULL AND idle_expires_at>? AND expires_at>?`,stamp,new Date(Date.now()+idleMs).toISOString(),tokenHash,session.id,stamp,stamp);
    if (!result.count) return null;
  }
  return session;
}

export async function clientActor(db:Db,request:Request,options:{touch?:boolean;recent?:boolean}={}) {
  if (!clientPortalEnabled()) return fail(404,"Client portal unavailable.");
  const session = await rawClientSession(db,customerToken(request.headers.get("cookie")),options.touch);
  if (!session) return fail(401,"Sign in to your client account.");
  if (!session.verifiedAt) return fail(403,"Verify your email address before opening the client portal.");
  if (options.recent && (!session.authenticatedAt || Date.now()-Date.parse(session.authenticatedAt)>recentMs)) {
    return fail(403,"Confirm your password in Security to continue.");
  }
  return {id:session.id,name:session.name,email:session.email,sessionId:session.sessionId,verifiedAt:session.verifiedAt} satisfies ClientActor;
}

function describeDevice(agent:string) {
  const os = /Android/i.test(agent)?"Android":/iPad|iPhone|iPod/i.test(agent)?"iOS":/Windows/i.test(agent)?"Windows"
    :/Macintosh|Mac OS/i.test(agent)?"macOS":/CrOS/i.test(agent)?"ChromeOS":/Linux/i.test(agent)?"Linux":"an unknown device";
  const browser = /Edg\//i.test(agent)?"Edge":/Firefox|FxiOS/i.test(agent)?"Firefox":/Chrome|CriOS/i.test(agent)?"Chrome":/Safari/i.test(agent)?"Safari":"Web browser";
  return `${browser} on ${os}`;
}
export function clientSessionResponse(request:Request,token:string,body:Record<string,unknown>,status=200) {
  return json(body,status,{"Set-Cookie":sessionSet(request,token,token?customerSessionSeconds:0,customerCookie)});
}
export async function clientSecurityEvent(db:Db,accountId:string,sessionRef:string|null,event:string,notice?:{title:string;body:string;recipient?:string}) {
  const eventId = id();
  await run(db,"INSERT INTO client_security_events(id,customer_id,session_ref,event,created_at) VALUES (?,?,?,?,?)",
    eventId,accountId,sessionRef,event,now());
  if (notice) await notifyClient(db,accountId,{type:"security",title:notice.title,body:notice.body,href:"/customer/security",dedupeKey:`security:${eventId}`,...(notice.recipient?{securityRecipient:notice.recipient}:{})});
}
export async function issueClientSession(db:Db,request:Request,account:Customer,alertForNewDevice:boolean) {
  const token = randomBytes(32).toString("hex"), ref = id();
  const stamp = now(), agent = (request.headers.get("user-agent") ?? "").slice(0,300);
  const deviceDigest = clientPrivateDigest("client-device",JSON.stringify([describeDevice(agent),clientAddress(request)]));
  const [previous,known] = await Promise.all([
    one(db,"SELECT id FROM customer_sessions WHERE customer_id=? AND session_ref IS NOT NULL LIMIT 1",account.id),
    one(db,"SELECT id FROM customer_sessions WHERE customer_id=? AND device_digest=? LIMIT 1",account.id,deviceDigest),
  ]);
  await run(db,`INSERT INTO customer_sessions(id,customer_id,expires_at,session_ref,created_at,last_seen_at,idle_expires_at,reauthenticated_at,device_label,device_digest)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,await digest(token),account.id,new Date(Date.now()+customerSessionSeconds*1000).toISOString(),
    ref,stamp,stamp,new Date(Date.now()+idleMs).toISOString(),stamp,describeDevice(agent),deviceDigest);
  await run(db,`UPDATE customer_sessions SET ended_at=?,expires_at=LEAST(expires_at,?) WHERE id IN (
    SELECT id FROM customer_sessions WHERE customer_id=? AND ended_at IS NULL AND expires_at>?
    ORDER BY created_at DESC NULLS LAST,id DESC OFFSET 20)`,stamp,stamp,account.id,stamp);
  await clientSecurityEvent(db,account.id,ref,"Signed in",alertForNewDevice&&previous&&!known
    ?{title:"Sign-in from an unfamiliar device or network",body:"A new device or network accessed your account. Review active sessions and change your password if you don’t recognize this sign-in."}:undefined);
  return token;
}

export async function endClientSessions(db:Db,customerId:string,keepHash?:string) {
  const stamp = now();
  return run(db,`UPDATE customer_sessions SET ended_at=?,expires_at=LEAST(expires_at,?)
    WHERE customer_id=? AND ended_at IS NULL ${keepHash?"AND id<>?":""}`,stamp,stamp,customerId,...(keepHash?[keepHash]:[]));
}

export async function clientSessionStatus(db:Db,request:Request,touch=false) {
  const session = await rawClientSession(db,customerToken(request.headers.get("cookie")),touch);
  if (!session) return fail(401,"Sign in to your client account.");
  return json({ok:true,id:session.id,name:session.name,email:session.email,verified:!!session.verifiedAt,sessionId:session.sessionId});
}

export async function listClientSessions(db:Db,actor:ClientActor) {
  const [sessions,events] = await Promise.all([
    all(db,`SELECT session_ref AS id,device_label AS device,created_at AS "createdAt",last_seen_at AS "lastSeenAt",
      expires_at AS "expiresAt",CASE WHEN ended_at IS NOT NULL THEN ended_at WHEN idle_expires_at<=? THEN idle_expires_at
      WHEN expires_at<=? THEN expires_at END AS "endedAt",session_ref=? AS current
      FROM customer_sessions WHERE customer_id=? AND session_ref IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 50`,now(),now(),actor.sessionId,actor.id),
    all(db,`SELECT id,event,created_at AS "createdAt",session_ref AS "sessionId" FROM client_security_events
      WHERE customer_id=? ORDER BY created_at DESC,id DESC LIMIT 50`,actor.id),
  ]);
  return json({currentSessionId:actor.sessionId,sessions,events});
}

export async function revokeClientSessions(db:Db,request:Request,actor:ClientActor,target?:string) {
  if (target&&!validClientId.test(target)) return fail(404,"Session unavailable.");
  const ended = await db.transaction(async tx=>{
    if (!target) {
      const tokenHash=await digest(customerToken(request.headers.get("cookie")));
      const revoked = await endClientSessions(tx,actor.id,tokenHash);
      if(revoked.count)await clientSecurityEvent(tx,actor.id,actor.sessionId,"Other sessions ended");
      return revoked.count;
    }
    const stamp = now();
    const revoked = await run(tx,`UPDATE customer_sessions SET ended_at=?,expires_at=LEAST(expires_at,?)
      WHERE customer_id=? AND session_ref=? AND ended_at IS NULL AND expires_at>? AND idle_expires_at>?`,stamp,stamp,actor.id,target,stamp,stamp);
    if (!revoked.count) return fail(404,"Session unavailable.");
    await clientSecurityEvent(tx,actor.id,actor.sessionId,target===actor.sessionId?"Signed out":"A session was revoked");
    return revoked.count;
  });
  if (target===actor.sessionId) return clientSessionResponse(request,"",{ok:true,message:"Signed out."});
  return json({ok:true,message:ended?"Session access revoked.":"No other active sessions."});
}
export async function signOutClient(db:Db,request:Request,token:string) {
  const session=await rawClientSession(db,token);
  if (session) await db.transaction(async tx=>{
    const stamp=now();
    const ended=await run(tx,"UPDATE customer_sessions SET ended_at=?,expires_at=LEAST(expires_at,?) WHERE id=? AND customer_id=? AND ended_at IS NULL",
      stamp,stamp,session.sessionHash,session.id);
    if(ended.count)await clientSecurityEvent(tx,session.id,session.sessionId,"Signed out");
  });
  return clientSessionResponse(request,"",{ok:true});
}

export async function reauthenticateClient(db:Db,request:Request,actor:ClientActor,data:Record<string,unknown>) {
  const password = data.password;
  if(typeof password!=="string"||!password||password.length>160)return fail(400,"Enter your current password.");
  await throttle(db,`client-reauth:${actor.id}`,6,300_000);
  const session = await digest(customerToken(request.headers.get("cookie")));
  await db.transaction(async tx=>{
    const customer = await one<{password_hash:string;suspended_at:string|null}>(tx,"SELECT password_hash,suspended_at FROM customers WHERE id=? FOR UPDATE",actor.id);
    if (!customer || customer.suspended_at || !await passwordMatches(password,customer.password_hash)) return fail(401,"Current password is incorrect.");
    const stamp = now();
    const updated = await run(tx,`UPDATE customer_sessions SET reauthenticated_at=? WHERE id=? AND customer_id=?
      AND ended_at IS NULL AND expires_at>? AND idle_expires_at>?`,stamp,session,actor.id,stamp,stamp);
    if (!updated.count) return fail(401,"Sign in to your client account.");
    await clientSecurityEvent(tx,actor.id,actor.sessionId,"Password confirmed");
  });
  return json({ok:true,message:"Password confirmed."});
}
