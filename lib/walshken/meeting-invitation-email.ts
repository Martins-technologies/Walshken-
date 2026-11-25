import {createHash} from "node:crypto";
import {after} from "next/server";
import {meetingGuestLink, meetingInvitesEnabled} from "./meeting-invitations";
import {decryptSettings, id, notify, now, one, orgId, run, type Db} from "./server";
import {validateEmailSettings} from "./staff-delivery";

type Sender={apiKey:string;from:string};
type Job={
  id:string; org_id:string; guest_id:string; meeting_id:string; event_type:"Invitation"|"Reminder"|"Rescheduled"|"Cancelled";
  meeting_revision:number; attempts:number; first_attempt_at:string|null; lease_token:string;
  transport_key_hash:string|null; payload_hash:string|null; created_at:string;
};
type MessageSource={
  title:string; starts_at:string; ends_at:string; guest_time_zone:string; guest_description:string; guest_instructions:string;
  organizer:string; guest_revision:number; token_nonce:string; email:string; expires_at:string; revoked_at:string|null;
  cancelled_at:string|null; ended_at:string|null; rsvp:string; external_meetings:number; organizer_id:string;
};
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");

async function sender(db:Db):Promise<Sender|null> {
  const integration=await one<{configuration:string}>(db,"SELECT configuration FROM integrations WHERE id='resend' AND enabled=1");
  if (!integration) return null;
  const settings=await decryptSettings("resend",integration.configuration) as Sender;
  validateEmailSettings(settings);
  return settings;
}

export async function meetingInvitationEmailConfigured(db:Db) {
  if (!meetingInvitesEnabled()) return false;
  try { return !!await sender(db); } catch { return false; }
}

async function claim(db:Db,scope?:{meeting:string;org:string}) {
  const stamp=now(), lease=id();
  const available=new Date(Date.now()+60_000).toISOString();
  return db.transaction(async tx=>{
    const job=await one<{id:string}>(tx,`SELECT id FROM staff_meeting_guest_emails WHERE org_id=? AND
      ((status IN ('Queued','Retry') AND available_at<=?) OR (status='Processing' AND lease_until<=?))
      ${scope?"AND meeting_id=?":""} ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,scope?.org??orgId,stamp,stamp,...scope?[scope.meeting]:[]);
    if (!job) return null;
    return one<Job>(tx,"UPDATE staff_meeting_guest_emails SET status='Processing',lease_token=?,lease_until=? WHERE id=? AND org_id=? RETURNING *",lease,available,job.id,scope?.org??orgId);
  });
}
async function finish(db:Db,job:Job,status:string,error:string|null,providerId?:string,availableAt?:string) {
  return run(db,`UPDATE staff_meeting_guest_emails SET status=?,error_code=?,provider_id=?,available_at=COALESCE(?,available_at),sent_at=?,
    lease_token=NULL,lease_until=NULL WHERE id=? AND org_id=? AND status='Processing' AND lease_token=?`,
    status,error,providerId??null,availableAt??null,status==="Sent"?now():null,job.id,job.org_id,job.lease_token);
}

function makePayload(job:Job,m:MessageSource,from:string) {
  const humanDate = new Intl.DateTimeFormat("en-US", {weekday:"long",year:"numeric",month:"long",day:"numeric",
    hour:"numeric",minute:"2-digit",timeZone:m.guest_time_zone,timeZoneName:"short"});
  const start=humanDate.format(new Date(m.starts_at));
  const end=humanDate.format(new Date(m.ends_at));
  const duration=Math.round((Date.parse(m.ends_at)-Date.parse(m.starts_at))/60_000);
  const label:Record<Job["event_type"],string>={Invitation:"Meeting invitation",Reminder:"Meeting reminder",Rescheduled:"Meeting rescheduled",Cancelled:"Meeting cancelled"};
  const subject=`${label[job.event_type]} | Walshken · ${m.title.replace(/[\r\n]+/g," ")}`;
  const link=job.event_type==="Cancelled"?null:meetingGuestLink({id:job.guest_id,org_id:job.org_id,meeting_id:job.meeting_id,token_nonce:m.token_nonce});
  const summary=[
    label[job.event_type],m.title,`Organized by ${m.organizer}`,`Starts ${start}`,`Ends ${end}`,
    `Time zone ${m.guest_time_zone} · ${duration} minutes`,m.guest_description,m.guest_instructions,
  ].filter(Boolean);
  const help=link?"Open this secure link on the device you plan to use. Please keep it private.":"This meeting has been cancelled.";
  const htmlEscape=(s:string)=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  const html=`<div style="margin:0 auto;max-width:540px;padding:26px;color:#17233a;font:16px/1.55 Arial,sans-serif"><p style="font-weight:bold;color:#164878;font-size:22px">Walshken</p>${summary.map((line,i)=>i===1?`<h1 style="margin:0;font-size:25px">${htmlEscape(line)}</h1>`:`<p>${htmlEscape(line)}</p>`).join("")}${link?`<p><a style="display:inline-block;padding:11px 16px;background:#164878;color:white;border-radius:6px;text-decoration:none" href="${htmlEscape(link)}">Open meeting invitation</a></p>`:""}<p>${htmlEscape(help)}</p></div>`;
  return {from:`Walshken <${from}>`,to:[m.email],subject,text:["Walshken",...summary,...(link?[link]:[]),help].join("\n\n"),html};
}

export async function processMeetingInvitationEmails(db:Db,budgetMs=11_000,scope?:{meeting:string;org:string}) {
  const result={provider:"disabled",processed:0,sent:0,retry:0,failed:0,superseded:0};
  if (!meetingInvitesEnabled() || budgetMs<1000) return result;
  let settings:Sender|null;
  try { settings=await sender(db); } catch {result.provider="configuration_error";return result;}
  if (!settings) { result.provider="disconnected";return result; }
  result.provider="configured";
  const deadline=Date.now()+Math.min(20_000,budgetMs),transport=sha(settings.apiKey);
  for (let i=0;i<4&&Date.now()<=deadline-1000;i++) {
    const job=await claim(db,scope); if (!job) break;
    result.processed++;
    const meeting=await one<MessageSource>(db,`SELECT m.title,m.starts_at,m.ends_at,m.guest_time_zone,m.guest_description,m.guest_instructions,m.guest_revision,
      m.cancelled_at,m.ended_at,m.organizer_id,e.name AS organizer,g.token_nonce,g.email,g.expires_at,g.revoked_at,g.rsvp,o.external_meetings
      FROM staff_meeting_guest_emails q JOIN staff_meeting_guests g ON g.id=q.guest_id AND g.org_id=q.org_id AND g.meeting_id=q.meeting_id
      JOIN meetings m ON m.id=q.meeting_id AND m.org_id=q.org_id JOIN organizations o ON o.id=q.org_id JOIN employees e ON e.id=m.organizer_id AND e.org_id=m.org_id
      WHERE q.id=? AND q.org_id=? AND q.lease_token=? AND q.status='Processing' AND q.lease_until>?`,job.id,job.org_id,job.lease_token,now());
    const cancelled=job.event_type==="Cancelled";
    const authorize=meeting && !meeting.revoked_at && meeting.rsvp!=="Declined" && meeting.guest_revision===job.meeting_revision
      && (cancelled ? !!meeting.cancelled_at : !!meeting.external_meetings && !meeting.ended_at && !meeting.cancelled_at && meeting.expires_at>now())
      && (job.event_type!=="Reminder" || meeting.starts_at>now());
    if (!authorize) { await finish(db,job,"Superseded","invitation_changed"); result.superseded++;continue; }
    if (job.attempts>=5 || job.first_attempt_at && Date.now()-Date.parse(job.first_attempt_at)>22*3_600_000) {
      await finish(db,job,"Failed","retry_window_closed");result.failed++;continue;
    }
    let encoded:string;
    try { encoded=JSON.stringify(makePayload(job,meeting,settings.from)); }
    catch { await finish(db,job,"Failed","invitation_link_configuration");result.failed++;continue; }
    const payloadHash=sha(encoded);
    if (job.transport_key_hash&&job.transport_key_hash!==transport || job.payload_hash&&job.payload_hash!==payloadHash) {
      await finish(db,job,"Failed","sender_or_message_changed");result.failed++;continue;
    }
    const allowed=await run(db,`UPDATE staff_meeting_guest_emails SET attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,?),
      transport_key_hash=?,payload_hash=? WHERE id=? AND org_id=? AND status='Processing' AND lease_token=? AND lease_until>?
      AND EXISTS(SELECT 1 FROM integrations WHERE id='resend' AND enabled=1)`,now(),transport,payloadHash,job.id,job.org_id,job.lease_token,now());
    if (allowed.count!==1) continue;
    const response=await fetch("https://api.resend.com/emails",{
      method:"POST",headers:{Authorization:`Bearer ${settings.apiKey}`,"Content-Type":"application/json","Idempotency-Key":`walshken-meeting/${job.org_id}/${job.id}`},
      body:encoded,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(Math.max(1,Math.min(8000,deadline-Date.now()))),
    }).catch(()=>null);
    const receipt=response?.ok?await response.json().catch(()=>null):null;
    if (response?.ok&&typeof receipt?.id==="string"&&/^[A-Za-z0-9_-]{1,200}$/.test(receipt.id)) {
      await db.transaction(async tx=>{
        const sent=await finish(tx,job,"Sent",null,receipt.id);
        if (sent.count!==1) return;
        if(job.event_type==="Invitation")await notify(tx,meeting.organizer_id,"External invitation accepted by email provider",meeting.title,`/staff/calls?meeting=${encodeURIComponent(job.meeting_id)}`).run();
        await run(tx,"INSERT INTO audit(id,org_id,actor_id,action,entity,target_id) VALUES (?,?,NULL,?,'meeting invitation',?)",id(),job.org_id,`External meeting ${job.event_type.toLowerCase()} accepted by email provider`,job.guest_id);
      });
      result.sent++;continue;
    }
    const retryable=!response||response.ok||[408,409,429].includes(response.status)||response.status>=500;
    const error=response?`provider_${response.status}`:"transport_unavailable";
    if (retryable&&job.attempts<4) {
      const retryAfter=Number(response?.headers.get("retry-after"));
      const delay=Math.min(3_600_000,Math.max(60_000*2**job.attempts,Number.isFinite(retryAfter)?retryAfter*1000:0));
      await finish(db,job,"Retry",error,undefined,new Date(Date.now()+delay).toISOString());result.retry++;
    }else{await finish(db,job,"Failed",error);result.failed++;}
  }
  return result;
}


export function dispatchMeetingInvitationEmails(db:Db,scope:{meeting:string;org:string}) {
  if(!meetingInvitesEnabled()||process.env.NODE_ENV==="test")return;
  after(async()=>{
    try{await processMeetingInvitationEmails(db,11_000,scope);}
    catch{console.error("Meeting invitation email delivery queued for retry.");}
  });
}
