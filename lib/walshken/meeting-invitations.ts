import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { meetingLocalCandidates } from "./meeting-time";
import { actionScope } from "./staff-authority";
import { all, audit, cookieValue, datetime, digest, email, fail, id, json, notify, now, one, pick, run, str, timeZone, type Actor, type Db } from "./server";
import { isMissing, liveKitSettings, participantToken, providerCall, publishSources, roomClient } from "./livekit";
import { recordingConsentRequired, recordingPermitted } from "./meeting-recording-policy";
import { stopForGuestRecordingRefusal } from "./meetings";

export const meetingInvitesEnabled = () => process.env.WALSHKEN_MANAGEMENT_INVITES_ENABLED === "1";
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const guestPrefix = "meeting-guest-";
function guestIdentity(id: string, nonce: string) {
  return `${guestPrefix}${id}.${createHash("sha256").update(nonce).digest("hex").slice(0,24)}`;
}
export function parseGuestIdentity(identity: string) {
  const [guest,revision,extra] = identity.startsWith(guestPrefix)?identity.slice(guestPrefix.length).split("."):[];
  return uuid.test(guest??"")&&/^[a-f0-9]{24}$/.test(revision??"")&&extra===undefined?guest:null;
}
export type GuestMeeting = {
  id: string; org_id: string; organizer_id: string; title: string; starts_at: string; ends_at: string;
  mode: string; provider_room: string | null; screen_sharing: string; waiting_room: number; locked_at: string | null;
  recording_enabled: number; recording_category?: string | null; recording_retention_days: number;
  started_at: string | null; ended_at: string | null; cancelled_at: string | null;
  guest_description: string; guest_instructions: string; guest_time_zone: string; guest_revision: number;
};
type Guest = {
  id: string; org_id: string; meeting_id: string; email: string; name: string; token_nonce: string; session_hash: string | null;
  expires_at: string; requested_at: string | null; admitted_at: string | null; revoked_at: string | null;
  rsvp: "Invited" | "Accepted" | "Declined"; recording_consent: number | null; can_publish: number; can_share: number;
};
type GuestPolicy = { external_meetings: number; external_guest_admission: "Host approval" | "Invitation only" };
type Delivery = "Invitation" | "Reminder" | "Rescheduled" | "Cancelled";

const linkTo = (meeting: string) => `/staff/calls?meeting=${encodeURIComponent(meeting)}`;
const guestDisplay = (guest: Pick<Guest,"name">) => guest.name || "Invited guest";
const activeMeeting = (meeting: GuestMeeting) => !meeting.ended_at && !meeting.cancelled_at && meeting.ends_at > now();
const meetingJoinWindow = (meeting: GuestMeeting) => activeMeeting(meeting)&&Date.now()>=Date.parse(meeting.starts_at)-900_000;
const guestOpen = (guest: Guest) => !guest.revoked_at && guest.expires_at > now();
const lobbyRequired = (meeting: GuestMeeting, policy: GuestPolicy) => !!meeting.waiting_room || policy.external_guest_admission === "Host approval";

export async function externalGuestPolicy(db: Db, org: string) {
  return one<GuestPolicy>(db, "SELECT external_meetings,external_guest_admission FROM organizations WHERE id=?", org);
}

export async function canInviteMeetingGuests(db: Db, actor: Actor) {
  if (!meetingInvitesEnabled() || actor.role === "guest") return false;
  const a = actionScope(actor, "calls.external.invite", "e", false);
  return !!await one(db, `SELECT id FROM employees e WHERE e.org_id=? AND e.id=? AND (${a.sql})`, actor.org_id, actor.id, ...a.args);
}

export async function requireMeetingGuestInviter(db: Db, actor: Actor) {
  if (!meetingInvitesEnabled() || !await canInviteMeetingGuests(db, actor) || !(await externalGuestPolicy(db, actor.org_id))?.external_meetings) {
    return fail(403, "External email invitations are disabled or outside your meeting permissions.");
  }
}

export function canConfigureMeetingGuests(actor: Actor) {
  if (actor.role === "super_admin") return true;
  const rules = (actor.permissions ?? []).filter(r => r.action === "calls.external.configure" && r.scope_type === "organization");
  return actor.role !== "guest" && rules.some(r => r.effect === "allow") && !rules.some(r => r.effect === "deny");
}

export function meetingGuestAddresses(input: unknown): string[] {
  if (input === undefined || input === "") return [];
  const parts = typeof input === "string" ? input.split(/[\n;,]+/).map(v => v.trim()).filter(Boolean) : input;
  if (!Array.isArray(parts) || parts.length > 30) return fail(400, "Enter at most 30 external email addresses.");
  return [...new Set(parts.map(email))];
}

export function guestMeetingFields(data: Record<string, unknown>, actor: Actor) {
  return {
    description: str(data.description, "meeting description", 2000, false),
    instructions: str(data.instructions, "meeting instructions", 1600, false),
    zone: timeZone(data.timeZone || actor.time_zone || "UTC"),
  };
}

export function scheduledMeetingTime(raw:unknown,label:string,zone:string) {
  if(typeof raw!=="string"||!/\dT\d{2}:\d{2}$/.test(raw))return datetime(raw,label);
  const candidates=meetingLocalCandidates(raw,zone);
  if(!candidates.length)return fail(400,`Enter a valid ${label} in ${zone}. This local time may not exist at a clock change.`);
  if(candidates.length>1)return fail(400,`Choose an unambiguous ${label} or enter the intended UTC time using UTC as the meeting time zone.`);
  return candidates[0];
}

export function meetingGuestSecret(guest: Pick<Guest,"id"|"meeting_id"|"org_id"|"token_nonce">, key: string) {
  return createHmac("sha256", key).update(JSON.stringify(["walshken-meeting-invitation-v1", guest.org_id, guest.meeting_id, guest.id, guest.token_nonce])).digest("base64url");
}
function invitationKey() {
  const key = process.env.WALSHKEN_MEETING_INVITE_KEY || process.env.WALSHKEN_INTEGRATION_KEY_V2 || process.env.WALSHKEN_INTEGRATION_KEY;
  if (!key || key.length < 32) return fail(503, "External invitations require a server signing key.");
  return key;
}
export function meetingGuestLink(guest: Pick<Guest,"id"|"meeting_id"|"org_id"|"token_nonce">) {
  const preview = process.env.VERCEL_ENV === "preview";
  const previewDomain = process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL;
  const value = preview ? (previewDomain ? `https://${previewDomain}` : "") : process.env.WALSHKEN_STAFF_EMAIL_ORIGIN;
  let url: URL;
  try { url = new URL(value || ""); } catch { return fail(503, "Configure the staff email origin for external invitations."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || (preview && !url.hostname.endsWith(".vercel.app"))) {
    return fail(503, "The staff email origin is invalid for this deployment.");
  }
  const path = new URL("/meeting-access", url);
  path.hash = `${guest.id}.${meetingGuestSecret(guest, invitationKey())}`;
  return path.toString();
}

async function queueGuestEmail(db: Db, guest: Guest, event: Delivery, revision: number, at = now()) {
  const key = `${event}/${revision}/${event === "Invitation" || event === "Reminder" ? guest.token_nonce : ""}`;
  await run(db, `INSERT INTO staff_meeting_guest_emails(id,guest_id,org_id,meeting_id,event_key,event_type,meeting_revision,status,available_at,created_at)
    VALUES (?,?,?,?,?,?,?,'Queued',?,?) ON CONFLICT(guest_id,event_key) DO NOTHING`, id(), guest.id, guest.org_id, guest.meeting_id, key, event, revision, at, now());
}

async function queueReminder(db: Db, guest: Guest, meeting: GuestMeeting) {
  const at = new Date(Date.parse(meeting.starts_at) - 30 * 60_000).toISOString();
  if (at > now()) await queueGuestEmail(db, guest, "Reminder", meeting.guest_revision, at);
}

export async function inviteMeetingGuests(db: Db, actor: Actor, meeting: GuestMeeting, addresses: string[]) {
  if (!addresses.length) return 0;
  await requireMeetingGuestInviter(db, actor);
  const [internal, external] = await Promise.all([
    one<{ n: number }>(db, "SELECT count(*)::int AS n FROM meeting_members WHERE meeting_id=? AND removed_at IS NULL", meeting.id),
    all<Guest>(db, "SELECT * FROM staff_meeting_guests WHERE meeting_id=? AND org_id=?", meeting.id, actor.org_id),
  ]);
  const openAddresses = new Set(external.filter(item => !item.revoked_at && item.rsvp !== "Declined").map(item => item.email));
  const fresh = addresses.filter(addr => !openAddresses.has(addr));
  if ((internal?.n ?? 0) + openAddresses.size + fresh.length > 100) return fail(409, "A meeting can have no more than 100 total participants.");
  for (const addr of fresh) {
    if (await one(db, "SELECT id FROM employees WHERE org_id=? AND lower(email)=? AND role<>'guest'", actor.org_id, addr)) {
      return fail(400, "Add your organization's staff via the internal participant selector.");
    }
    const nonce = id();
    const row = await one<Guest>(db, `INSERT INTO staff_meeting_guests(id,org_id,meeting_id,email,token_nonce,invited_by,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(meeting_id,email) DO UPDATE SET name='',token_nonce=excluded.token_nonce,invited_by=excluded.invited_by,
      expires_at=excluded.expires_at,session_hash=NULL,rsvp='Invited',rsvp_at=NULL,requested_at=NULL,admitted_at=NULL,revoked_at=NULL,
      recording_consent=NULL,consent_at=NULL,can_publish=1,can_share=0 RETURNING *`, id(), actor.org_id, meeting.id, addr, nonce, actor.id, now(), meeting.ends_at);
    if (!row) return fail(503, "Could not save the external invitation.");
    await queueGuestEmail(db, row, "Invitation", meeting.guest_revision);
    await queueReminder(db, row, meeting);
    await audit(db, actor, "External meeting invitation queued", "meeting invitation", row.id).run();
  }
  return fresh.length;
}

export async function guestMeetingIdentityAllowed(db: Db, meeting: GuestMeeting, identity: string, recordingActive: boolean, participantSid: string, consentSnapshot=false) {
  const guestId = parseGuestIdentity(identity);
  if (!guestId || !meetingInvitesEnabled() || !meetingJoinWindow(meeting)) return false;
  const [guest, policy] = await Promise.all([
    one<Guest>(db, "SELECT * FROM staff_meeting_guests WHERE id=? AND meeting_id=? AND org_id=?", guestId, meeting.id, meeting.org_id),
    externalGuestPolicy(db, meeting.org_id),
  ]);
  if (!guest || guestIdentity(guest.id,guest.token_nonce)!==identity || !policy?.external_meetings || !guestOpen(guest) || guest.rsvp !== "Accepted" || (lobbyRequired(meeting, policy) && !guest.admitted_at)) return false;
  if (meeting.locked_at && !await one(db,"SELECT guest_id FROM staff_meeting_guest_presence WHERE guest_id=? AND meeting_id=? AND participant_sid=? AND left_at IS NULL",guest.id,meeting.id,participantSid)) return false;
  return !recordingActive || guest.recording_consent === 1 || (guest.recording_consent !== 0 && !consentSnapshot && !await recordingConsentRequired(db, meeting));
}

export async function missingGuestRecordingConsent(db: Db, meeting: Pick<GuestMeeting,"id"|"org_id">) {
  return meetingInvitesEnabled() && !!await one(db, `SELECT id FROM staff_meeting_guests WHERE meeting_id=? AND org_id=?
    AND revoked_at IS NULL AND expires_at>? AND rsvp<>'Declined' AND COALESCE(recording_consent,0)<>1 LIMIT 1`, meeting.id, meeting.org_id, now());
}

export async function declinedGuestRecordingConsent(db: Db, meeting: Pick<GuestMeeting,"id"|"org_id">) {
  return meetingInvitesEnabled() && !!await one(db, `SELECT id FROM staff_meeting_guests WHERE meeting_id=? AND org_id=?
    AND revoked_at IS NULL AND expires_at>? AND rsvp<>'Declined' AND recording_consent=0 LIMIT 1`, meeting.id, meeting.org_id, now());
}

export async function guestRoster(db: Db, m: GuestMeeting, host: boolean) {
  if (!meetingInvitesEnabled()) return [];
  return all(db, `SELECT g.id,COALESCE(NULLIF(g.name,''),'Invited guest') AS name,g.rsvp,g.requested_at,g.admitted_at,g.revoked_at,
    g.can_publish,g.can_share,g.recording_consent,CASE WHEN ?=1 THEN g.email ELSE NULL END AS email,
    CASE WHEN ?=1 THEN e.status ELSE NULL END AS delivery,CASE WHEN ?=1 THEN e.error_code ELSE NULL END AS delivery_error,
    CASE WHEN ?=1 THEN e.event_type ELSE NULL END AS delivery_event,
    EXISTS(SELECT 1 FROM staff_meeting_guest_presence a WHERE a.guest_id=g.id AND a.left_at IS NULL AND a.joined_at IS NOT NULL) AS connected
    FROM staff_meeting_guests g LEFT JOIN LATERAL (SELECT status,error_code,event_type FROM staff_meeting_guest_emails
    WHERE guest_id=g.id AND (event_type<>'Reminder' OR status='Sent') ORDER BY created_at DESC,id DESC LIMIT 1) e ON true
    WHERE g.meeting_id=? AND g.org_id=? ORDER BY g.created_at,g.id`, host?1:0,host?1:0,host?1:0,host?1:0,m.id,m.org_id);
}

export async function guestAttendance(db: Db, meeting: Pick<GuestMeeting,"id"|"org_id">) {
  if (!meetingInvitesEnabled()) return [];
  return all(db,`SELECT g.id,'External guest' AS employee_no,COALESCE(NULLIF(g.name,''),g.email) AS name,
    min(a.joined_at) AS first_join,max(a.left_at) AS last_leave,count(a.joined_at)::int AS connections,
    COALESCE(SUM(CASE WHEN a.joined_at IS NOT NULL THEN GREATEST(0,EXTRACT(EPOCH FROM COALESCE(a.left_at,?)::timestamptz-a.joined_at::timestamptz)) ELSE 0 END),0)::int AS seconds,
    COALESCE(bool_or(a.left_at IS NULL AND a.joined_at IS NOT NULL),false) AS connected
    FROM staff_meeting_guests g LEFT JOIN staff_meeting_guest_presence a ON a.guest_id=g.id
    WHERE g.meeting_id=? AND g.org_id=? GROUP BY g.id ORDER BY name`,now(),meeting.id,meeting.org_id);
}

export async function recordGuestPresence(db: Db, meeting: GuestMeeting, identity: string, sid: string, stamp: string, joined: boolean, reason = "Disconnected") {
  const guestId = parseGuestIdentity(identity);
  if (!guestId || !meetingInvitesEnabled()) return;
  await run(db, `INSERT INTO staff_meeting_guest_presence(participant_sid,guest_id,org_id,meeting_id,joined_at,left_at,reason)
    SELECT ?,id,org_id,meeting_id,?,?,? FROM staff_meeting_guests WHERE id=? AND meeting_id=? AND org_id=?
    ON CONFLICT(participant_sid) DO UPDATE SET joined_at=COALESCE(staff_meeting_guest_presence.joined_at,excluded.joined_at),
    left_at=COALESCE(staff_meeting_guest_presence.left_at,excluded.left_at),reason=COALESCE(staff_meeting_guest_presence.reason,excluded.reason)`,
    sid,joined?stamp:null,joined?null:stamp,joined?null:reason,guestId,meeting.id,meeting.org_id);
}
export async function closeGuestPresence(db: Db, meeting: GuestMeeting, at: string, reason: string) {
  if (meetingInvitesEnabled()) await run(db, "UPDATE staff_meeting_guest_presence SET left_at=?,reason=? WHERE meeting_id=? AND org_id=? AND left_at IS NULL",at,reason,meeting.id,meeting.org_id);
}

export async function disconnectMeetingGuest(db: Db, meeting: Pick<GuestMeeting,"provider_room">, guest: string, nonce: string) {
  if (!meeting.provider_room) return;
  const client = roomClient(await liveKitSettings(db));
  await providerCall(async () => {
    try { await client.removeParticipant(meeting.provider_room!, guestIdentity(guest,nonce), {revokeTokenTs:BigInt(Math.floor(Date.now() / 1000)+1)}); }
    catch (e) { if (!isMissing(e)) throw e; }
  });
}

async function supersedeEmail(db: Db, meeting: Pick<GuestMeeting,"id"|"org_id">, guestId?: string) {
  await run(db,`UPDATE staff_meeting_guest_emails SET status='Superseded',lease_token=NULL,lease_until=NULL
    WHERE meeting_id=? AND org_id=? AND status IN ('Queued','Retry','Processing') ${guestId?"AND guest_id=?":""}`,meeting.id,meeting.org_id,...guestId?[guestId]:[]);
}

export async function updateMeetingGuestSchedule(db: Db, actor: Actor, meeting: GuestMeeting, cancelled: boolean) {
  if (!meetingInvitesEnabled()) return;
  const guests = await all<Guest>(db, "SELECT * FROM staff_meeting_guests WHERE meeting_id=? AND org_id=? AND revoked_at IS NULL",meeting.id,meeting.org_id);
  await supersedeEmail(db, meeting);
  for (const guest of guests) {
    const updated={...guest,token_nonce:cancelled?guest.token_nonce:id()};
    await run(db,"UPDATE staff_meeting_guests SET expires_at=?,requested_at=NULL,admitted_at=NULL,token_nonce=?,session_hash=? WHERE id=? AND org_id=?",
      meeting.ends_at,updated.token_nonce,cancelled?guest.session_hash:null,guest.id,meeting.org_id);
    if (guest.rsvp !== "Declined") {
      await queueGuestEmail(db,updated,cancelled?"Cancelled":"Rescheduled",meeting.guest_revision);
      if (!cancelled) await queueReminder(db,updated,meeting);
    }
  }
  for (const row of await all<{employee_id:string}>(db, "SELECT employee_id FROM meeting_members WHERE meeting_id=? AND removed_at IS NULL AND employee_id<>?",meeting.id,actor.id)) {
    await notify(db,row.employee_id,cancelled?"Meeting cancelled":"Meeting rescheduled",meeting.title,linkTo(meeting.id)).run();
  }
}

export async function rescheduleGuestMeeting(db: Db, actor: Actor, meeting: GuestMeeting, data: Record<string,unknown>) {
  if (meeting.started_at || !activeMeeting(meeting)) return fail(409,"Only scheduled meetings can be rescheduled.");
  const zone = timeZone(data.timeZone || meeting.guest_time_zone || actor.time_zone || "UTC");
  const start=scheduledMeetingTime(data.startsAt,"meeting start",zone),end=scheduledMeetingTime(data.endsAt,"meeting end",zone);
  if (start < now() || end<=start || Date.parse(end)-Date.parse(start)>43_200_000) return fail(400,"Choose future start and end times no more than 12 hours apart.");
  if (start===meeting.starts_at && end===meeting.ends_at && zone===meeting.guest_time_zone) return json({ok:true,message:"The existing meeting time is already selected."});
  const revision=meeting.guest_revision+1;
  await run(db, "UPDATE meetings SET starts_at=?,ends_at=?,guest_time_zone=?,guest_revision=? WHERE id=? AND org_id=?",start,end,zone,revision,meeting.id,meeting.org_id);
  await updateMeetingGuestSchedule(db,actor,{...meeting,starts_at:start,ends_at:end,guest_time_zone:zone,guest_revision:revision},false);
  await audit(db,actor,"Meeting rescheduled","meeting",meeting.id).run();
  return json({ok:true,message:"Meeting rescheduled and updated notices queued."});
}

export async function manageExternalMeetingGuest(db: Db, actor: Actor, meeting: GuestMeeting, action: string, data: Record<string,unknown>) {
  const guest = await one<Guest>(db,"SELECT * FROM staff_meeting_guests WHERE id=? AND meeting_id=? AND org_id=? FOR UPDATE",str(data.guest,"guest invitation",80),meeting.id,actor.org_id);
  if (!guest || guest.revoked_at) return fail(404,"External invitation unavailable.");
  let providerRemovalPending=false;
  if (action==="guest-admit") {
    if (!guest.requested_at || guest.admitted_at || guest.rsvp!=="Accepted" || meeting.locked_at || !guestOpen(guest)) return fail(409,"This guest cannot be admitted.");
    await run(db,"UPDATE staff_meeting_guests SET admitted_at=? WHERE id=?",now(),guest.id);
  } else if (action==="guest-permissions") {
    const publish=pick(data.publish,["0","1"],"microphone and camera permission")==="1"?1:0;
    const share=pick(data.share,["0","1"],"screen sharing permission")==="1"?1:0;
    if (meeting.provider_room) {
      const client=roomClient(await liveKitSettings(db));
      const sources=publishSources(meeting.mode,meeting.screen_sharing,publish,share,false);
      await providerCall(async()=>{try{await client.updateParticipant(meeting.provider_room!,guestIdentity(guest.id,guest.token_nonce),{permission:{canSubscribe:true,canPublish:!!sources.length,canPublishSources:sources,canPublishData:false,canUpdateMetadata:false}});}catch(e){if(!isMissing(e))throw e;}});
    }
    await run(db,"UPDATE staff_meeting_guests SET can_publish=?,can_share=? WHERE id=?",publish,share,guest.id);
  } else if (action==="guest-revoke") {
    await run(db,"UPDATE staff_meeting_guests SET revoked_at=?,session_hash=NULL WHERE id=?",now(),guest.id);
    await supersedeEmail(db,meeting,guest.id);
    try { await disconnectMeetingGuest(db,meeting,guest.id,guest.token_nonce); }
    catch { providerRemovalPending=true; }
  } else if (action==="guest-resend") {
    await requireMeetingGuestInviter(db, actor);
    if (!guestOpen(guest) || guest.rsvp==="Declined" || meeting.started_at) return fail(409,"Only an open invitation for a scheduled meeting can be resent.");
    if (await one(db,"SELECT id FROM staff_meeting_guest_emails WHERE guest_id=? AND event_type='Invitation' AND created_at>? LIMIT 1",guest.id,new Date(Date.now()-60_000).toISOString())) {
      return fail(429,"Wait a minute before resending this invitation.");
    }
    const nonce=id();
    await supersedeEmail(db,meeting,guest.id);
    await run(db,"UPDATE staff_meeting_guests SET token_nonce=?,session_hash=NULL,requested_at=NULL,admitted_at=NULL WHERE id=?",nonce,guest.id);
    const updated={...guest,token_nonce:nonce};
    await queueGuestEmail(db,updated,"Invitation",meeting.guest_revision);
    await queueReminder(db,updated,meeting);
  } else return fail(404,"External guest action unavailable.");
  await audit(db,actor,`External meeting ${action}`,"meeting invitation",guest.id).run();
  const message=action==="guest-resend"?"Invitation queued. Its previous link has been revoked."
    :providerRemovalPending?"Guest access revoked. Removing the current connection will be retried.":"External guest access updated.";
  return json({ok:true,message});
}

type GuestSession = GuestMeeting & GuestPolicy & {
  guest_id:string; organizer:string; guest_email:string; guest_name:string; expires_at:string;
  session_hash:string|null; token_nonce:string; requested_at:string|null; admitted_at:string|null;
  revoked_at:string|null; rsvp:Guest["rsvp"]; recording_consent:number|null; can_publish:number; can_share:number;
};
function receiveGuestCookie(request:Request, guest:string) {
  return cookieValue(request.headers.get("cookie"),`wk_meeting_${guest}`).slice(0,80);
}
async function guestAudit(db:Db, session:GuestSession, event:string) {
  await run(db,"INSERT INTO audit(id,org_id,actor_id,action,entity,target_id) VALUES (?,?,NULL,?,'external meeting guest',?)",id(),session.org_id,event,session.guest_id);
}
async function invitedSession(db: Db, guestId: string, lock: boolean) {
  return one<GuestSession>(db,`SELECT m.*,g.id AS guest_id,e.name AS organizer,g.email AS guest_email,g.name AS guest_name,g.expires_at,
    g.session_hash,g.token_nonce,g.requested_at,g.admitted_at,g.revoked_at,g.rsvp,g.recording_consent,g.can_publish,g.can_share,
    o.external_meetings,o.external_guest_admission FROM staff_meeting_guests g
    JOIN meetings m ON m.id=g.meeting_id AND m.org_id=g.org_id JOIN organizations o ON o.id=g.org_id
    JOIN employees e ON e.id=m.organizer_id AND e.org_id=m.org_id WHERE g.id=? AND m.provider='livekit' ${lock?"FOR UPDATE OF m,g":""}`,guestId);
}
function activeGuestRecording(db:Db, meetingId:string) {
  return one<{status:"Starting"|"Active"|"Stopping";participant_consent_required?:boolean|null}>(db,"SELECT * FROM meeting_recordings WHERE meeting_id=? AND status IN ('Starting','Active','Stopping') LIMIT 1",meetingId);
}
async function guestSessionView(db: Db, session: GuestSession) {
  const open=meetingJoinWindow(session);
  const roster=open&&session.rsvp==="Accepted"&&(!lobbyRequired(session,session)||!!session.admitted_at)
    ? await all<{name:string}>(db,`SELECT e.name FROM employees e JOIN meeting_members m ON m.employee_id=e.id
      WHERE m.meeting_id=? AND m.removed_at IS NULL AND e.org_id=? AND e.status='Active'
      UNION ALL SELECT g.name FROM staff_meeting_guests g WHERE g.meeting_id=? AND g.org_id=? AND g.revoked_at IS NULL
      AND g.rsvp='Accepted' AND g.name<>'' AND EXISTS (SELECT 1 FROM staff_meeting_guest_presence a WHERE a.guest_id=g.id AND a.joined_at IS NOT NULL AND a.left_at IS NULL)`,session.id,session.org_id,session.id,session.org_id)
    : [];
  const [recording,consentRequired,recordingEnabled]=await Promise.all([
    activeGuestRecording(db,session.id),recordingConsentRequired(db,session),
    session.recording_enabled?recordingPermitted(db,session):false,
  ]);
  const recordingRequired=!!recording?.participant_consent_required||consentRequired;
  const recordingBlocked=!!recording&&(session.recording_consent===0||(session.recording_consent!==1&&recordingRequired));
  return {
    ok:true, title:session.title, organizer:session.organizer, description:session.guest_description, instructions:session.guest_instructions,
    startsAt:session.starts_at,endsAt:session.ends_at,timeZone:session.guest_time_zone,mode:session.mode,
    status:session.cancelled_at?"Cancelled":session.ended_at||session.ends_at<=now()?"Ended":session.rsvp,
    guestName:session.guest_name,canJoin:open&&!session.locked_at&&!recordingBlocked,waiting:!!session.requested_at&&!session.admitted_at,
    joinStartsAt:new Date(Date.parse(session.starts_at)-900_000).toISOString(),locked:!!session.locked_at,canPublish:!!session.can_publish,
    waitingRoom:lobbyRequired(session,session),recordingEnabled,recordingRequired,recordingStatus:recording?.status??null,recordingBlocked,
    recordingConsent:session.recording_consent,retentionDays:session.recording_retention_days, roster,
  };
}
export async function guestMeetingAction(db: Db, request: Request, action: string, data: Record<string,unknown>): Promise<Response> {
  if (!meetingInvitesEnabled()) return fail(404,"External meeting invitations are unavailable.");
  const guest = str(data.guest,"guest invitation",80);
  if (!uuid.test(guest)) return fail(404,"External meeting invitation unavailable.");
  return db.transaction(async tx => {
    const session = await invitedSession(tx,guest,action!=="status");
    if (!session || session.revoked_at || !session.external_meetings || session.expires_at<=now()) return fail(404,"This invitation is unavailable, expired or revoked.");
    if (action==="exchange") {
      const offered=str(data.token,"invitation token",80);
      const expected=meetingGuestSecret({id:guest,meeting_id:session.id,org_id:session.org_id,token_nonce:session.token_nonce},invitationKey());
      if (!/^[a-zA-Z0-9_-]{43}$/.test(offered) || !timingSafeEqual(Buffer.from(offered),Buffer.from(expected))) return fail(404,"This invitation is unavailable, expired or revoked.");
      if (session.session_hash) {
        if (await digest(receiveGuestCookie(request,guest))!==session.session_hash) return fail(409,"This invitation has already been opened. Ask the organizer for a new invitation.");
        return json(await guestSessionView(tx,session));
      }
      const value=id()+id();
      await run(tx,"UPDATE staff_meeting_guests SET session_hash=? WHERE id=?",await digest(value),guest);
      await guestAudit(tx,session,"External meeting invitation authenticated");
      const seconds=Math.max(1,Math.ceil((Date.parse(session.expires_at)-Date.now())/1000));
      return json(await guestSessionView(tx,session),200,{"Set-Cookie":`wk_meeting_${guest}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/api/meeting-guest; Max-Age=${seconds}`});
    }
    const cookie=receiveGuestCookie(request,guest);
    if (!cookie || !session.session_hash || await digest(cookie)!==session.session_hash) return fail(401,"Open your original meeting invitation link.");
    if (action==="status") return json(await guestSessionView(tx,session));
    if (!activeMeeting(session)) return fail(409,"This meeting has ended or was cancelled.");
    if (action==="accept" || action==="decline") {
      if (session.rsvp==="Declined" && action==="accept") return fail(409,"This invitation was declined. Ask the organizer for a new invitation.");
      const rsvp=action==="accept"?"Accepted":"Declined",name=action==="accept"?str(data.name,"display name",100):session.guest_name;
      if (session.rsvp!==rsvp) {
        await run(tx,"UPDATE staff_meeting_guests SET rsvp=?,name=?,rsvp_at=? WHERE id=?",rsvp,name,now(),guest);
        if (rsvp==="Declined") {
          await supersedeEmail(tx,session,guest);
          try { await disconnectMeetingGuest(tx,session,guest,session.token_nonce); }
          catch { /* Signed joins and maintenance recheck RSVP before allowing access. */ }
        }
        await notify(tx,session.organizer_id,`External meeting invitation ${rsvp.toLowerCase()}`,`${session.title} · ${session.guest_email}`,linkTo(session.id)).run();
        await guestAudit(tx,session,`Meeting invitation ${rsvp.toLowerCase()}`);
      }
      return json(await guestSessionView(tx,{...session,rsvp,guest_name:name}));
    }
    if (session.rsvp!=="Accepted") return fail(403,"Accept your invitation before opening the meeting.");
    if (action==="consent") {
      const consent=pick(data.consent,["0","1"],"recording consent")==="1"?1:0;
      if (!session.recording_enabled || (consent===1&&!await recordingPermitted(tx,session))) return fail(409,"Recording is disabled for this meeting.");
      if (session.recording_consent!==consent) {
        await run(tx,"UPDATE staff_meeting_guests SET recording_consent=?,consent_at=? WHERE id=?",consent,now(),guest);
        if (!consent) {
          await stopForGuestRecordingRefusal(tx,session);
          if (await activeGuestRecording(tx,session.id)) {
            try { await disconnectMeetingGuest(tx,session,guest,session.token_nonce); } catch { /* Signed joins and maintenance recheck consent. */ }
          }
        }
        await guestAudit(tx,session,consent?"External participant gave recording consent":"External participant declined or withdrew recording consent");
      }
      return json(await guestSessionView(tx,{...session,recording_consent:consent}));
    }
    if (action==="leave") {
      await disconnectMeetingGuest(tx,session,guest,session.token_nonce);
      return json({ok:true});
    }
    if (action!=="join") return fail(404,"Meeting access action unavailable.");
    if (session.locked_at || !meetingJoinWindow(session)) return fail(409,"The meeting is locked or has not opened yet.");
    const recording=await activeGuestRecording(tx,session.id);
    if (recording && (session.recording_consent===0 || session.recording_consent!==1&&(recording.participant_consent_required||await recordingConsentRequired(tx,session)))) {
      return fail(409,"Recording is active. You may join after giving consent or after recording stops.");
    }
    if (lobbyRequired(session,session) && !session.admitted_at) {
      if (!session.requested_at) {
        await run(tx,"UPDATE staff_meeting_guests SET requested_at=? WHERE id=?",now(),guest);
        await notify(tx,session.organizer_id,"External participant waiting",`${session.title} · ${session.guest_email}`,linkTo(session.id)).run();
        await guestAudit(tx, session,"External guest requested admission");
      }
      return json({ok:true,waiting:true},202);
    }
    const settings=await liveKitSettings(tx),room=session.provider_room??`wk-${session.id}`;
    await providerCall(()=>roomClient(settings).createRoom({name:room,emptyTimeout:300,departureTimeout:30,maxParticipants:102,metadata:JSON.stringify({meeting:session.id,endsAt:session.ends_at})}));
    await run(tx,"UPDATE meetings SET provider_room=? WHERE id=?",room,session.id);
    const sources=publishSources(session.mode,session.screen_sharing,session.can_publish,session.can_share,false);
    const token=await participantToken(settings,room,guestIdentity(guest,session.token_nonce),guestDisplay({name:session.guest_name}),sources,session.ends_at);
    await guestAudit(tx,session,"External guest LiveKit access authorized");
    return json({ok:true,token,serverUrl:settings.url,mode:session.mode,endsAt:session.ends_at,canPublish:!!session.can_publish});
  });
}

export async function processInternalMeetingReminders(db:Db,org:string) {
  if(!meetingInvitesEnabled())return 0;
  const stamp=now(),until=new Date(Date.now()+30*60_000).toISOString();
  return db.transaction(async tx=>{
    const due=await all<{meeting_id:string;employee_id:string;guest_revision:number;title:string}>(tx,`SELECT m.id AS meeting_id,p.employee_id,m.guest_revision,m.title
      FROM meetings m JOIN meeting_members p ON p.meeting_id=m.id JOIN employees e ON e.id=p.employee_id AND e.org_id=m.org_id
      WHERE m.org_id=? AND m.provider='livekit' AND m.starts_at>? AND m.starts_at<=? AND m.started_at IS NULL AND m.ended_at IS NULL
        AND m.cancelled_at IS NULL AND p.removed_at IS NULL AND e.role<>'guest' AND e.status='Active' AND e.employment_status<>'Ended'
        AND NOT EXISTS (SELECT 1 FROM staff_meeting_internal_reminders r WHERE r.meeting_id=m.id AND r.employee_id=p.employee_id AND r.meeting_revision=m.guest_revision)
      ORDER BY m.starts_at,m.id,p.employee_id LIMIT 100 FOR SHARE OF m,p`,org,stamp,until);
    let sent=0;
    for(const row of due){
      const claimed=await run(tx,"INSERT INTO staff_meeting_internal_reminders(org_id,meeting_id,employee_id,meeting_revision,sent_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",org,row.meeting_id,row.employee_id,row.guest_revision,stamp);
      if(!claimed.count)continue;
      await notify(tx,row.employee_id,"Meeting starts soon",row.title,linkTo(row.meeting_id)).run();
      sent++;
    }
    return sent;
  });
}
