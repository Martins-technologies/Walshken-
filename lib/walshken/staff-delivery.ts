import {publicEndpoint} from "./payroll-calculator";
import {employmentEngineEnabled} from "./employment-catalog";
import {quarantinedUpload} from "./upload-quarantine";
import { createHash } from "node:crypto";
import { decryptSettings, fail, one, type Actor,type Db } from "./server";
import { staffReadinessEnabled } from "./staff-permissions";

type ScannerSettings = { endpoint: string; apiKey: string };

function scannerEndpoint(settings: ScannerSettings) {
  let endpoint: URL;
  try { endpoint = new URL(settings.endpoint); }
  catch { return fail(400,"Enter a valid HTTPS scanner endpoint."); }
  const hosts = (process.env.WALSHKEN_SCANNER_ALLOWED_HOSTS ?? "").split(",").map(host=>host.trim().toLowerCase());
  if (endpoint.protocol!=="https:" || endpoint.username || endpoint.password || endpoint.port || endpoint.hash || endpoint.search || !hosts.includes(endpoint.hostname)) {
    return fail(400,"Use an HTTPS scanner hostname approved in WALSHKEN_SCANNER_ALLOWED_HOSTS.");
  }
  if (settings.apiKey.length<32) return fail(400,"The scanner access token must contain at least 32 characters.");
  return endpoint.href;
}

export async function verifyScanner(settings: ScannerSettings) {
  const endpoint = scannerEndpoint(settings);
  await publicEndpoint(endpoint);
  const result = await fetch(endpoint,{headers:{Authorization:`Bearer ${settings.apiKey}`},redirect:"error",signal:AbortSignal.timeout(8_000),cache:"no-store"}).catch(()=>null);
  if (!result?.ok) return fail(502,"The scanner did not confirm its connection.");
  const health = await result.json().catch(()=>null);
  if (health?.protocol!=="walshken-scan-v1" || health?.ready!==true) return fail(502,"The scanner or signatures are unavailable.");
}

export async function scanStaffUpload(db: Db, bytes: Buffer,actor:Actor,name:string) {
  if (!staffReadinessEnabled()) return;
  if(employmentEngineEnabled())return quarantinedUpload(db,actor,bytes,name,()=>scanBytes(db,bytes));
  if(await scanBytes(db,bytes)==='infected')return fail(422,'This file did not pass malware screening.');
}
async function scanBytes(db:Db,bytes:Buffer):Promise<'clean'|'infected'> {
  const row = await one<{configuration:string}>(db,"SELECT configuration FROM integrations WHERE id='malware-scanner' AND enabled=1");
  if (!row) return fail(503,"Upload scanning is unavailable. Ask your administrator to connect the malware scanner.");
  const settings = await decryptSettings("malware-scanner",row.configuration) as ScannerSettings;
  const endpoint = scannerEndpoint(settings);
  await publicEndpoint(endpoint);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const response = await fetch(endpoint,{
    method:"POST",headers:{Authorization:`Bearer ${settings.apiKey}`,"Content-Type":"application/octet-stream","X-Content-SHA256":sha256},
    body:Uint8Array.from(bytes),redirect:"error",signal:AbortSignal.timeout(20_000),cache:"no-store",
  }).catch(()=>null);
  if (!response?.ok) return fail(503,"The malware scanner is unavailable. Upload paused.");
  const verdict = await response.json().catch(()=>null);
  if (verdict?.protocol!=="walshken-scan-v1" || verdict?.sha256!==sha256) return fail(503,"The scanner did not confirm this file.");
  if (verdict.verdict==="infected") return "infected";
  if (verdict.verdict!=="clean") return fail(503,"The scanner could not complete its check.");
  return "clean";
}

type EmailSettings = { apiKey:string; from:string };
export async function sendAccessCode(db: Db, to: string, code: string, invitationId: string, site: string) {
  const row = await one<{configuration:string}>(db,"SELECT configuration FROM integrations WHERE id='resend' AND enabled=1");
  if (!row) return "disconnected" as const;
  const settings = await decryptSettings("resend",row.configuration) as EmailSettings;
  const response = await fetch("https://api.resend.com/emails",{
    method:"POST",headers:{Authorization:`Bearer ${settings.apiKey}`,"Content-Type":"application/json","Idempotency-Key":`staff-access/${invitationId}`},
    body:JSON.stringify({from:settings.from,to:[to],subject:"Your Walshken staff access code",
      text:`Open ${site}/staff and select “I have an activation or admin reset code.” Use this code within 48 hours: ${code}.`}),
    redirect:"error",signal:AbortSignal.timeout(10_000),cache:"no-store",
  }).catch(()=>null);
  return response?.ok ? "sent" as const : "failed" as const;
}

export function validateEmailSettings(settings: EmailSettings) {
  if (!/^re_[A-Za-z0-9_-]{10,200}$/.test(settings.apiKey) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(settings.from)) {
    return fail(400,"Provide a Resend API key and a verified sender email address.");
  }
}
