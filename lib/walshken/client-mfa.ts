import { randomBytes } from "node:crypto";
import { passwordMatches } from "./passwords";
import { clientPrivateDigest, clientSecurityEvent, clientSessionResponse, endClientSessions, type ClientActor } from "./client-sessions";
import { decryptSettings, fail, json, now, one, run, throttle, type Db } from "./server";
import { encryptSettings } from "./server";
import { authenticatorSetupKey, matchingAuthenticatorStep } from "./totp";

type Factor = {
  secret: string | null;
  pending_secret: string | null;
  pending_expires_at: Date | null;
  confirmed_at: Date | null;
  last_step: number;
};

const keyLabel = (id: string) => "client-authenticator:" + id;
const hashRecovery = (id: string, input: string) => clientPrivateDigest(keyLabel(id), input.toLowerCase());
const factorFor = (db: Db, id: string, lock = false) => one<Factor>(db,
  "SELECT secret,pending_secret,pending_expires_at,confirmed_at,last_step FROM client_mfa WHERE customer_id=?"+(lock ? " FOR UPDATE" : ""),id);

export async function clientMfaSummary(db: Db, id: string) {
  const factor = await factorFor(db,id);
  const remaining = !factor?.confirmed_at ? null : await one<{count:number}>(db,
    "SELECT count(*)::int AS count FROM client_mfa_recovery WHERE customer_id=?",id);
  return json({enabled:!!factor?.confirmed_at,recoveryCodesRemaining:remaining?.count??0});
}

export async function verifyClientMfa(db: Db, id: string, value: unknown, required = false) {
  const factor = await factorFor(db,id,true);
  if (!factor?.confirmed_at || !factor.secret) {
    if (required) return fail(409,"Set up your authenticator before continuing.");
    return;
  }
  const input = typeof value === "string" ? value.trim() : "";
  if (!input) return fail(428,"Enter your authenticator or recovery code.");
  if (/^[a-f0-9]{24}$/i.test(input)) {
    const result=await run(db,"DELETE FROM client_mfa_recovery WHERE customer_id=? AND code_hash=?",id,hashRecovery(id,input));
    if (result.count===1) return;
  }
  const { secret }=await decryptSettings(keyLabel(id),factor.secret);
  const step=matchingAuthenticatorStep(Buffer.from(secret,"base64"),input);
  if (step===undefined || step<=factor.last_step) return fail(401,"Use a valid, fresh authenticator or recovery code.");
  await run(db,"UPDATE client_mfa SET last_step=? WHERE customer_id=?",step,id);
}

export async function clientMfaAction(request: Request,db: Db,actor: ClientActor,action: string,data: Record<string,unknown>) {
  await throttle(db,"client-mfa:"+actor.id,8,300_000);
  const password=data.password;
  if (typeof password!=="string" || !password || password.length>160) return fail(400,"Enter your current password.");
  return db.transaction(async tx=>{
    const account=await one<{password_hash:string}>(tx,"SELECT password_hash FROM customers WHERE id=? AND suspended_at IS NULL FOR UPDATE",actor.id);
    if (!account || !await passwordMatches(password,account.password_hash)) return fail(401,"Current password is incorrect.");
    const factor=await factorFor(tx,actor.id,true);
    if (action==="mfa-setup") {
      if(factor?.confirmed_at) await verifyClientMfa(tx,actor.id,data.code,true);
      const raw=randomBytes(20),cipher=await encryptSettings(keyLabel(actor.id),{secret:raw.toString("base64")});
      const deadline=new Date(Date.now()+10*60_000).toISOString();
      await run(tx,`INSERT INTO client_mfa(customer_id,pending_secret,pending_expires_at) VALUES(?,?,?)
        ON CONFLICT(customer_id) DO UPDATE SET pending_secret=excluded.pending_secret,pending_expires_at=excluded.pending_expires_at`,actor.id,cipher,deadline);
      const setupKey=authenticatorSetupKey(raw);
      const uri="otpauth://totp/"+encodeURIComponent("Walshken:"+actor.email)+"?"+new URLSearchParams({secret:setupKey,issuer:"Walshken",algorithm:"SHA1",digits:"6",period:"30"});
      return json({setupKey,uri,deadline});
    }
    if (action==="mfa-confirm") {
      if(!factor?.pending_secret || !factor.pending_expires_at || new Date(factor.pending_expires_at).getTime()<=Date.now()) return fail(409,"Start a new authenticator setup.");
      const {secret}=await decryptSettings(keyLabel(actor.id),factor.pending_secret);
      const step=matchingAuthenticatorStep(Buffer.from(secret,"base64"),typeof data.code==="string"?data.code.trim():"");
      if(step===undefined)return fail(401,"The authenticator code is incorrect or expired.");
      await run(tx,"UPDATE client_mfa SET secret=pending_secret,pending_secret=NULL,pending_expires_at=NULL,confirmed_at=?,last_step=? WHERE customer_id=?",now(),step,actor.id);
      await run(tx,"DELETE FROM client_mfa_recovery WHERE customer_id=?",actor.id);
      const recoveryCodes=Array.from({length:8},()=>randomBytes(12).toString("hex"));
      for(const code of recoveryCodes)await run(tx,"INSERT INTO client_mfa_recovery(customer_id,code_hash) VALUES(?,?)",actor.id,hashRecovery(actor.id,code));
      await endClientSessions(tx,actor.id);
      await clientSecurityEvent(tx,actor.id,actor.sessionId,factor.confirmed_at?"Authenticator replaced":"Authenticator enabled",
        {title:"Authenticator updated",body:"Two-step verification was updated. Review your sessions if you did not make this change."});
      return clientSessionResponse(request,"",{ok:true,recoveryCodes,message:"Two-step verification saved. Sign in again."});
    }
    if (action==="mfa-disable") {
      await verifyClientMfa(tx,actor.id,data.code,true);
      await run(tx,"DELETE FROM client_mfa WHERE customer_id=?",actor.id);
      await endClientSessions(tx,actor.id);
      await clientSecurityEvent(tx,actor.id,actor.sessionId,"Authenticator disabled",
        {title:"Authenticator disabled",body:"Two-step verification was turned off. Contact Walshken if you did not make this change."});
      return clientSessionResponse(request,"",{ok:true,message:"Two-step verification was turned off."});
    }
    return fail(404,"This authenticator action is unavailable.");
  });
}
