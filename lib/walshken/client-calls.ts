import { ParticipantInfo_Kind, ParticipantInfo_State } from "@livekit/protocol";
import type { ParticipantInfo, WebhookEvent } from "livekit-server-sdk";
import { clientCaseFor, staffCaseFor } from "./client-cases";
import { notifyClient } from "./client-notifications";
import { egressClient, isMissing, liveKitSettings, participantToken, providerCall, publishSources, roomClient, type LiveKitSettings } from "./livekit";
import { all, audit, fail, id, json, notify, now, one, orgId, pick, requireSuper, run, str, type Actor, type Db } from "./server";

const activeStatuses = "('Ringing','Accepted','Connected')";
const ringSeconds = 45_000;
const joinSeconds = 90_000;
const reconnectSeconds = 90_000;
const maximumCall = 90 * 60_000;
const clientCommunication = "/customer/contact";
const staffCommunication = "/staff/client-casework";
const roomPrefix = "wk-client-";
const callIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const after = (milliseconds: number) => new Date(Date.now() + milliseconds).toISOString();

type Side = "client" | "staff";
type Mode = "Audio" | "Video";
type CallStatus = "Ringing" | "Accepted" | "Connected" | "Busy" | "Unavailable" | "Missed" | "Declined" | "Ended" | "Cancelled";
type OpenStatus = "Ringing" | "Accepted" | "Connected";
type TerminalStatus = Exclude<CallStatus, OpenStatus>;
export type CallViewer = {side:"client"; id:string; name:string; sessionId:string} | {side:"staff"; id:string; name:string; sessionId:string; actor:Actor};
type Endpoint = { id:string; org_id:string; name:string; kind:"Office"|"Support"; employee_id:string; enabled:boolean; revision:number; employee_name?:string; available?:boolean };
type Call = {
  id:string; org_id:string; customer_id:string; case_id:string|null; employee_id:string|null; endpoint_id:string|null;
  company_name:string; client_name:string; initiator:Side; mode:Mode; status:CallStatus; provider_room:string;
  created_at:string; ring_expires_at:string; accepted_at:string|null; connect_expires_at:string|null; hard_expires_at:string|null;
  room_created_at:string|null; room_sid:string|null; room_closed_at:string|null; client_session_ref:string|null; staff_session_id:string|null;
  client_sid:string|null; staff_sid:string|null; client_signal_at:string|null; staff_signal_at:string|null;
  connected_at:string|null; reconnect_expires_at:string|null; checked_at:string|null; ended_at:string|null;
  case_reference?:string|null;
};

const isLive = (status: CallStatus): status is OpenStatus => status === "Ringing" || status === "Accepted" || status === "Connected";
const activeEmployee = (alias: string) => `${alias}.status='Active' AND ${alias}.employment_status<>'Ended' AND ${alias}.role<>'guest'`;
export function isClientCallRoom(room: string) {
  return room.startsWith(roomPrefix) && callIdPattern.test(room.slice(roomPrefix.length));
}

function companyAlias(value: string | null | undefined) {
  const name = value?.trim() ?? "";
  return name.length >= 2 && name.length <= 100 && !name.includes("@") && !/\d[\d ()+.-]{6,}\d/.test(name) ? name : null;
}

function viewerScope(viewer: CallViewer, alias = "x") {
  if (viewer.side === "client") return {sql:`${alias}.customer_id=? AND ${alias}.org_id=?`,args:[viewer.id,orgId]};
  return {sql:`${alias}.employee_id=? AND ${alias}.org_id=? AND (
    (${alias}.endpoint_id IS NULL AND EXISTS(SELECT 1 FROM client_cases c WHERE c.org_id=${alias}.org_id
      AND c.id=${alias}.case_id AND c.assigned_employee_id=${alias}.employee_id)) OR
    (${alias}.endpoint_id IS NOT NULL AND EXISTS(SELECT 1 FROM client_call_endpoints e WHERE e.org_id=${alias}.org_id
      AND e.id=${alias}.endpoint_id AND e.employee_id=${alias}.employee_id AND e.enabled)))`,args:[viewer.id,viewer.actor.org_id]};
}

const participantIdentity = (call: Call, side: Side) => `${side === "client" ? "client" : "company"}-${call.id}`;

async function byViewer(db: Db, viewer: CallViewer, reference: string, lock = false) {
  if (!callIdPattern.test(reference)) return fail(404, "Call unavailable.");
  const scope = viewerScope(viewer);
  const call = await one<Call>(db, `SELECT x.* FROM client_calls x WHERE x.id=? AND (${scope.sql}) ${lock ? "FOR UPDATE OF x" : ""}`, reference, ...scope.args);
  if (!call) return fail(404,"Call unavailable.");
  return call;
}

function callView(call: Call, viewer: CallViewer) {
  return {
    id:call.id, mode:call.mode, status:call.status,
    contact:viewer.side === "client" ? call.company_name : call.client_name,
    caseId:call.case_id, reference:call.case_reference ?? null,
    direction:call.initiator === viewer.side ? "outgoing" : "incoming",
    createdAt:call.created_at, ringUntil:call.ring_expires_at, acceptedAt:call.accepted_at, connectedAt:call.connected_at, endedAt:call.ended_at,
    canJoin:call.status === "Accepted" || call.status === "Connected",
  };
}

async function callAudit(db: Db, call: Call, action: string, viewer?: CallViewer) {
  await run(db,"INSERT INTO audit(id,org_id,actor_id,action,entity,target_id) VALUES(?,?,?,?,?,?)",
    id(),call.org_id,viewer?.side === "staff" ? viewer.id : null,action,"client call",call.id);
}

async function isAuthorized(db: Db, call: Call) {
  return Boolean(await one(db, `SELECT x.id FROM client_calls x
    JOIN customers customer ON customer.id=x.customer_id
    JOIN employees employee ON employee.org_id=x.org_id AND employee.id=x.employee_id
    WHERE x.id=? AND x.org_id=? AND customer.email_verified_at IS NOT NULL AND customer.suspended_at IS NULL
      AND ${activeEmployee("employee")}
      AND (x.case_id IS NULL OR EXISTS(SELECT 1 FROM client_cases c WHERE c.org_id=x.org_id AND c.id=x.case_id
        AND c.customer_id=x.customer_id AND c.communication_enabled AND (x.endpoint_id IS NOT NULL OR c.assigned_employee_id=x.employee_id)))
      AND (x.endpoint_id IS NULL OR EXISTS(SELECT 1 FROM client_call_endpoints e WHERE e.org_id=x.org_id AND e.id=x.endpoint_id
        AND e.employee_id=x.employee_id AND e.enabled))
      AND (x.client_session_ref IS NULL OR EXISTS(SELECT 1 FROM customer_sessions s WHERE s.customer_id=x.customer_id
        AND s.session_ref=x.client_session_ref AND s.ended_at IS NULL AND s.expires_at>? AND s.idle_expires_at>?))
      AND (x.staff_session_id IS NULL OR EXISTS(SELECT 1 FROM sessions s WHERE s.employee_id=x.employee_id
        AND s.id=x.staff_session_id AND s.ended_at IS NULL AND s.expires_at>?))`,call.id,call.org_id,now(),now(),now()));
}

async function finish(db: Db, call: Call, status: TerminalStatus, viewer?: CallViewer) {
  const ended = await one<Call>(db, `UPDATE client_calls SET status=?,ended_at=?,client_sid=NULL,staff_sid=NULL
    WHERE id=? AND status IN ${activeStatuses} RETURNING *`,status,now(),call.id);
  if (ended) await callAudit(db,call,`Client call ${status.toLowerCase()}`,viewer);
  return ended ?? call;
}

function deadlineStatus(call: Call, at: string): TerminalStatus | null {
  if (call.status === "Ringing" && call.ring_expires_at <= at) return "Missed";
  if (call.status === "Accepted" && call.connect_expires_at && call.connect_expires_at <= at) return "Unavailable";
  if (call.status === "Connected" && (call.hard_expires_at && call.hard_expires_at <= at || call.reconnect_expires_at && call.reconnect_expires_at <= at)) return "Ended";
  return null;
}

async function closeRoom(db: Db, call: Call, provider?: LiveKitSettings) {
  if (!call.room_created_at || call.room_closed_at) return;
  const settings = provider ?? await liveKitSettings(db);
  const remote = roomClient(settings);
  await Promise.allSettled((["client","staff"] as const).map(side=>remote.removeParticipant(call.provider_room,participantIdentity(call,side))));
  try { await remote.deleteRoom(call.provider_room); }
  catch (failure) { if (!isMissing(failure)) throw failure; }
  await run(db,"UPDATE client_calls SET room_closed_at=COALESCE(room_closed_at,?) WHERE id=? AND ended_at IS NOT NULL",now(),call.id);
}

async function tryClose(db: Db, call: Call, provider?: LiveKitSettings) {
  try { await closeRoom(db,call,provider); }
  catch { /* Keep the terminal record pending for the next maintenance or activity poll. */ }
}

async function applyPresence(db: Db, call: Call, clientSid: string | null, staffSid: string | null) {
  const joined = !!clientSid && !!staffSid;
  const at = now();
  const transitioning = joined && call.status === "Accepted";
  const next = await one<Call>(db, `UPDATE client_calls SET client_sid=?,staff_sid=?,
      status=CASE WHEN ? THEN 'Connected' ELSE status END,
      connected_at=CASE WHEN ? THEN COALESCE(connected_at,?) ELSE connected_at END,
      reconnect_expires_at=CASE WHEN ? THEN NULL WHEN status='Connected' THEN COALESCE(reconnect_expires_at,?) ELSE NULL END
    WHERE id=? AND status IN ('Accepted','Connected') RETURNING *`,clientSid,staffSid,joined,joined,at,joined,after(reconnectSeconds),call.id);
  if (next && transitioning) await callAudit(db,call,"Both participants connected to client call");
  return next ?? call;
}

async function checkProviderPresence(db: Db, call: Call) {
  const observedAt = now();
  const claimed = await run(db,`UPDATE client_calls SET checked_at=? WHERE id=? AND status IN ('Accepted','Connected')
    AND room_created_at IS NOT NULL AND (checked_at IS NULL OR checked_at<?)`,observedAt,call.id,after(-15_000));
  if (!claimed.count) return;
  try {
    const settings = await liveKitSettings(db);
    let participants: ParticipantInfo[];
    try { participants = await roomClient(settings).listParticipants(call.provider_room); }
    catch (failure) { if (!isMissing(failure)) throw failure; participants = []; }
    const sidFor = (side: Side) => participants.find(p => p.identity === participantIdentity(call,side) && p.state === ParticipantInfo_State.ACTIVE)?.sid ?? null;
    await db.transaction(async tx => {
      const latest = await one<Call>(tx,"SELECT * FROM client_calls WHERE id=? FOR UPDATE",call.id);
      if (latest?.room_created_at && (latest.status === "Accepted" || latest.status === "Connected") && latest.room_sid === call.room_sid) {
        const client = latest.client_signal_at && latest.client_signal_at >= observedAt ? latest.client_sid : sidFor("client");
        const staff = latest.staff_signal_at && latest.staff_signal_at >= observedAt ? latest.staff_sid : sidFor("staff");
        await applyPresence(tx,latest,client,staff);
      }
    });
  } catch { /* Transient provider errors are retried without changing attendance or call status. */ }
}

async function reconcile(db: Db, scope: {sql:string;args:string[]}, limit: number) {
  const open = await all<Call>(db,`SELECT x.* FROM client_calls x WHERE (${scope.sql}) AND x.status IN ${activeStatuses}
    ORDER BY x.created_at LIMIT ?`,...scope.args,limit);
  for (const initial of open) {
    const settled = await db.transaction(async tx => {
      const row = await one<Call>(tx,"SELECT * FROM client_calls WHERE id=? FOR UPDATE",initial.id);
      if (!row || !isLive(row.status)) return row;
      const status = !await isAuthorized(tx,row) ? "Cancelled" : deadlineStatus(row,now());
      return status ? finish(tx,row,status) : row;
    });
    if (!settled) continue;
    if (!isLive(settled.status)) await tryClose(db,settled);
    else if (settled.room_created_at) await checkProviderPresence(db,settled);
  }
  const closing = await all<Call>(db,`SELECT x.* FROM client_calls x WHERE (${scope.sql}) AND x.ended_at IS NOT NULL
    AND x.room_created_at IS NOT NULL AND x.room_closed_at IS NULL ORDER BY x.ended_at LIMIT ?`,...scope.args,limit);
  for (const call of closing) await tryClose(db,call);
}

function participantScope(viewer: CallViewer) {
  return viewer.side === "client"
    ? {sql:"x.org_id=? AND x.customer_id=?",args:[orgId,viewer.id]}
    : {sql:"x.org_id=? AND x.employee_id=?",args:[viewer.actor.org_id,viewer.id]};
}

export async function clientCallActivity(db: Db, viewer: CallViewer, caseId: string) {
  const org = viewer.side === "staff" ? viewer.actor.org_id : orgId;
  if (caseId) {
    if (viewer.side === "client") await clientCaseFor(db,viewer.id,caseId);
    else await staffCaseFor(db,viewer.actor,caseId);
  }
  await reconcile(db,participantScope(viewer),3);
  const scope = viewerScope(viewer);
  const configured = await liveKitSettings(db).then(() => true, () => false);
  const calls = await all<Call>(db, `SELECT x.*, c.reference AS case_reference FROM client_calls x
    LEFT JOIN client_cases c ON c.org_id=x.org_id AND c.id=x.case_id
    WHERE (${scope.sql}) AND (?='' OR x.case_id=? OR x.status IN ${activeStatuses})
    ORDER BY (x.status IN ${activeStatuses}) DESC,x.created_at DESC,x.id DESC LIMIT 30`,...scope.args,caseId,caseId);

  if (viewer.side === "staff") {
    const cases = await all<{id:string;reference:string;title:string;customer_name:string;representative_name:string|null}>(db,`SELECT c.id,c.reference,c.title,
      customer.name AS customer_name,c.representative_name FROM client_cases c JOIN customers customer ON customer.id=c.customer_id
      WHERE c.org_id=? AND c.assigned_employee_id=? AND c.communication_enabled AND customer.email_verified_at IS NOT NULL
        AND customer.suspended_at IS NULL AND (?='' OR c.id=?) ORDER BY c.updated_at DESC,c.id LIMIT 100`,org,viewer.id,caseId,caseId);
    return json({configured,calls:calls.map(call=>callView(call,viewer)),destinations:cases.map(row=>({id:row.id,caseId:row.id,
      name:row.customer_name,detail:row.reference,kind:"Client",available:!!companyAlias(row.representative_name)}))});
  }

  const [cases,endpoints] = await Promise.all([
    all<{id:string;reference:string;representative_name:string;representative_designation:string;available:boolean}>(db,`SELECT c.id,c.reference,c.representative_name,
      c.representative_designation,e.id IS NOT NULL AS available FROM client_cases c
      LEFT JOIN employees e ON e.id=c.assigned_employee_id AND e.org_id=c.org_id AND ${activeEmployee("e")}
      WHERE c.org_id=? AND c.customer_id=? AND c.communication_enabled AND (?='' OR c.id=?) ORDER BY c.updated_at DESC,c.id LIMIT 100`,org,viewer.id,caseId,caseId),
    all<Endpoint>(db, `SELECT r.id,r.name,r.kind,e.id IS NOT NULL AS available FROM client_call_endpoints r
      LEFT JOIN employees e ON e.id=r.employee_id AND e.org_id=r.org_id AND ${activeEmployee("e")}
      WHERE r.org_id=? AND r.enabled ORDER BY r.kind,r.name LIMIT 100`,org),
  ]);
  const representatives = cases.filter(row=>companyAlias(row.representative_name)).map(row=>({id:"representative",caseId:row.id,
    name:row.representative_name,detail:[companyAlias(row.representative_designation),row.reference].filter(Boolean).join(" · "),kind:"Representative",available:row.available}));
  return json({configured,calls:calls.map(call=>callView(call,viewer)),destinations:[...representatives,...endpoints.filter(e=>companyAlias(e.name))
    .map(e=>({id:e.id,caseId:null,name:e.name,detail:"",kind:e.kind,available:!!e.available}))]});
}

export async function startClientCall(db: Db, viewer: CallViewer, data: Record<string,unknown>) {
  const caseId = str(data.case,"case",80,false);
  const destination = str(data.target,"company call endpoint",80,false);
  const mode = pick(data.mode,["Audio","Video"] as const,"call type");
  if (viewer.side === "staff" && (!caseId || destination)) return fail(400,"Choose an assigned client case.");
  if (viewer.side === "client" && (!destination || destination === "representative" && !caseId)) return fail(400,"Choose an approved contact.");
  if (viewer.side === "client" && destination !== "representative" && caseId) return fail(400,"Company office or Support calls do not include case details.");
  const org = viewer.side === "client" ? orgId : viewer.actor.org_id;
  const initial = caseId ? viewer.side === "client" ? await clientCaseFor(db,viewer.id,caseId) : await staffCaseFor(db,viewer.actor,caseId) : null;
  if (initial && !initial.communication_enabled) return fail(403,"Calling is disabled for this case.");
  const configured = await liveKitSettings(db).then(() => true, () => false);
  await reconcile(db,participantScope(viewer),3);

  const row = await db.transaction(async tx => {
    const current = caseId ? viewer.side === "client" ? await clientCaseFor(tx,viewer.id,caseId,true) : await staffCaseFor(tx,viewer.actor,caseId,true) : null;
    if (current && !current.communication_enabled) return fail(403,"Calling is disabled for this case.");
    if (viewer.side === "staff" && current?.assigned_employee_id !== viewer.id) return fail(404,"Assigned case unavailable.");
    const endpoint = destination && destination !== "representative"
      ? await one<Endpoint>(tx,"SELECT * FROM client_call_endpoints WHERE id=? AND org_id=? AND enabled FOR SHARE",destination,org) : null;
    if (destination && destination !== "representative" && !endpoint) return fail(404,"Company contact unavailable.");
    const alias = companyAlias(endpoint?.name ?? current?.representative_name);
    if (!alias) return fail(409,"This contact needs an approved company display name before calling.");
    const customerId = viewer.side === "client" ? viewer.id : current!.customer_id;
    const potential = endpoint?.employee_id ?? current?.assigned_employee_id;
    const employee = potential && await one<{id:string}>(tx, `SELECT e.id FROM employees e WHERE org_id=? AND id=? AND ${activeEmployee("e")} FOR UPDATE`,org,potential);
    const customer = await one<{name:string}>(tx,"SELECT name FROM customers WHERE id=? AND email_verified_at IS NOT NULL AND suspended_at IS NULL FOR UPDATE",customerId);
    if (!customer) return fail(404,"Client access unavailable.");

    // The account locks above serialize overlapping reservations for both call participants.
    const occupied = employee && await all<Call>(tx,`SELECT x.* FROM client_calls x WHERE x.org_id=? AND (x.customer_id=? OR x.employee_id=?)
      AND x.status IN ${activeStatuses} ORDER BY x.id FOR UPDATE`,org,customerId,employee.id);
    let busy = false;
    const at = now();
    for (const previous of occupied || []) {
      const status = deadlineStatus(previous,at);
      if (status) await finish(tx,previous,status);
      else busy = true;
    }
    const target = id();
    const save = (status: "Unavailable" | "Busy" | "Ringing") => one<Call>(tx, `INSERT INTO client_calls(id,org_id,customer_id,case_id,employee_id,endpoint_id,company_name,client_name,
      initiator,mode,status,provider_room,created_at,ring_expires_at,ended_at,client_session_ref,staff_session_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING *`,target,org,customerId,current?.id ?? null,employee ? employee.id : null,endpoint?.id ?? null,
    alias,customer.name,viewer.side,mode,status,`${roomPrefix}${target}`,at,after(ringSeconds),status === "Ringing" ? null : at,
    status === "Ringing" && viewer.side === "client" ? viewer.sessionId : null,status === "Ringing" && viewer.side === "staff" ? viewer.sessionId : null);
    const status = !configured || !employee ? "Unavailable" : busy ? "Busy" : "Ringing";
    const call = await save(status) ?? (status === "Ringing" ? await save("Busy") : null);
    if (!call) return fail(503,"The call could not be created.");
    await callAudit(tx,call,`Client call ${call.status.toLowerCase()}`,viewer);
    if (call.status === "Ringing") {
      if (viewer.side === "client" && employee) await notify(tx,employee.id,"Incoming client call",`A client is requesting a ${mode.toLowerCase()} call.`,current
        ? `${staffCommunication}?case=${encodeURIComponent(current.id)}` : staffCommunication).run();
      if (viewer.side === "staff") await notifyClient(tx,customerId,{type:"call",title:"Incoming company call",body:`${alias} is calling. Open Communication to answer.`,
        href:clientCommunication,dedupeKey:`client-call:${call.id}`,email:false});
    }
    return call;
  });
  return json({call:callView(row,viewer)},row.status === "Ringing" ? 201 : 200);
}

export async function clientCallDecision(db: Db, viewer: CallViewer, action: "accept" | "decline" | "end", data: Record<string,unknown>) {
  const reference = str(data.id,"call",80);
  const result = await db.transaction(async tx => {
    const call = await byViewer(tx,viewer,reference,true);
    if (!isLive(call.status)) return call;
    const terminal = !await isAuthorized(tx,call) ? "Cancelled" : deadlineStatus(call,now());
    if (terminal) return finish(tx,call,terminal);
    if (action === "end") {
      if (call.status === "Ringing" && call.initiator !== viewer.side) return fail(403,"Decline an incoming call to dismiss it.");
      return finish(tx,call,call.status === "Ringing" ? "Cancelled" : "Ended",viewer);
    }
    if (call.initiator === viewer.side) return fail(403,"Only the recipient can answer this call.");
    if (action === "accept" && call.status !== "Ringing") return call;
    if (call.status !== "Ringing") return fail(409,"This call has already been accepted.");
    if (action === "decline") return finish(tx,call,"Declined",viewer);
    const accepted = await one<Call>(tx, `UPDATE client_calls SET status='Accepted',accepted_at=?,connect_expires_at=?,hard_expires_at=?,
      client_session_ref=COALESCE(client_session_ref,?),staff_session_id=COALESCE(staff_session_id,?)
      WHERE id=? RETURNING *`,now(),after(joinSeconds),after(maximumCall),viewer.side === "client" ? viewer.sessionId : null,
    viewer.side === "staff" ? viewer.sessionId : null,call.id);
    await callAudit(tx,call,"Client call accepted",viewer);
    return accepted ?? call;
  });
  if (!isLive(result.status)) await tryClose(db,result);
  return json({call:callView(result,viewer)});
}

export async function clientCallToken(db: Db, viewer: CallViewer, data: Record<string,unknown>) {
  const reference = str(data.id,"call",80);
  const access = await db.transaction(async tx => {
    const call = await byViewer(tx,viewer,reference,true);
    if (call.status !== "Accepted" && call.status !== "Connected") return fail(409,"The recipient must accept an active call before joining.");
    if (deadlineStatus(call,now()) || !await isAuthorized(tx,call)) return fail(403,"Calling access has expired or changed.");
    const settings = await liveKitSettings(tx);
    if (!call.room_created_at) {
      const room = await providerCall(() => roomClient(settings).createRoom({name:call.provider_room,maxParticipants:2,emptyTimeout:90,departureTimeout:90}));
      await run(tx,"UPDATE client_calls SET room_created_at=?,room_sid=?,room_closed_at=NULL WHERE id=?",now(),room.sid || null,call.id);
    }
    const value = viewer.side === "client" ? "client_session_ref" : "staff_session_id";
    if (call[value] !== viewer.sessionId) {
      await run(tx,`UPDATE client_calls SET ${value}=? WHERE id=?`,viewer.sessionId,call.id);
      await callAudit(tx,call,`Client call ${viewer.side} media access issued`,viewer);
    }
    const token = await participantToken(settings,call.provider_room,participantIdentity(call,viewer.side),
      viewer.side === "client" ? call.client_name : call.company_name,
      publishSources(call.mode,"Disabled",1,0,false),call.hard_expires_at!);
    return {serverUrl:settings.url,token,mode:call.mode,id:call.id};
  });
  return json(access);
}

export async function clientCallConfiguration(db: Db, actor: Actor) {
  requireSuper(actor);
  const [endpoints,staff,configured] = await Promise.all([
    all<Endpoint>(db, `SELECT r.id,r.name,r.kind,r.employee_id,r.enabled,r.revision,e.name AS employee_name
      FROM client_call_endpoints r JOIN employees e ON e.org_id=r.org_id AND e.id=r.employee_id WHERE r.org_id=? ORDER BY r.kind,r.name`,actor.org_id),
    all(db, `SELECT e.id,e.name FROM employees e WHERE e.org_id=? AND ${activeEmployee("e")} ORDER BY e.name,e.id LIMIT 500`,actor.org_id),
    liveKitSettings(db).then(() => true, () => false),
  ]);
  return json({endpoints,staff,configured});
}

export async function configureClientCall(db: Db, actor: Actor, data: Record<string,unknown>) {
  requireSuper(actor);
  const target = str(data.id,"company contact",80,false);
  const name = companyAlias(str(data.name,"company display name",100));
  if (!name) return fail(400,"Use a company display name without an email address or personal phone number.");
  const kind = pick(data.kind,["Office","Support"] as const,"routing type");
  const employee = str(data.employee,"responsible employee",80);
  const enabled = data.enabled;
  const revision = Number(data.revision);
  if (typeof enabled !== "boolean" || (target && (!Number.isSafeInteger(revision) || revision < 1))) return fail(400,"Choose valid company routing options.");
  await db.transaction(async tx => {
    await one(tx,"SELECT id FROM organizations WHERE id=? FOR UPDATE",actor.org_id);
    if (enabled && !await one(tx,`SELECT e.id FROM employees e WHERE e.org_id=? AND e.id=? AND ${activeEmployee("e")}`,actor.org_id,employee))
      return fail(404,"Choose an active routing employee.");
    const previous = target ? await one<Endpoint>(tx,"SELECT * FROM client_call_endpoints WHERE org_id=? AND id=? FOR UPDATE",actor.org_id,target) : null;
    if (target && !previous) return fail(404,"Company contact unavailable.");
    if (previous && previous.revision !== revision) return fail(409,"Reload these settings before updating this contact.");
    if (!enabled && (!previous || previous.employee_id !== employee) && !await one(tx,"SELECT id FROM employees WHERE org_id=? AND id=? AND role<>'guest'",actor.org_id,employee))
      return fail(404,"Choose an authorized routing employee.");
    const identifier = previous?.id ?? id();
    if (await one(tx,"SELECT id FROM client_call_endpoints WHERE org_id=? AND lower(name)=lower(?) AND id<>?",actor.org_id,name,identifier))
      return fail(409,"A company contact with that display name already exists.");
    const timestamp = now();
    await run(tx, `INSERT INTO client_call_endpoints(id,org_id,name,kind,employee_id,enabled,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,employee_id=excluded.employee_id,
      enabled=excluded.enabled,updated_at=excluded.updated_at,revision=client_call_endpoints.revision+1`,
    identifier,actor.org_id,name,kind,employee,enabled,timestamp,timestamp);
    await audit(tx,actor,previous ? "Client call routing updated" : "Client call routing created","client calling endpoint",identifier).run();
  });
  if (target) await reconcile(db,{sql:"x.org_id=? AND x.endpoint_id=?",args:[actor.org_id,target]},10);
  return json({ok:true});
}

export async function maintainClientCalls(db: Db, org: string) {
  await reconcile(db,{sql:"x.org_id=?",args:[org]},10);
}

export async function refreshClientCallCaseAccess(db: Db, org: string, caseId: string) {
  await reconcile(db,{sql:"x.org_id=? AND x.case_id=?",args:[org,caseId]},3);
}

export async function clientCallWebhook(db: Db, event: WebhookEvent, room: string, provider: LiveKitSettings) {
  const handlers = ["room_finished","participant_joined","participant_left","participant_connection_aborted","egress_started"];
  if (!isClientCallRoom(room) || !event.id || !handlers.includes(event.event)) return json({ok:true});
  await db.transaction(async tx => {
    const call = await one<Call>(tx,"SELECT * FROM client_calls WHERE provider_room=? AND org_id=? FOR UPDATE",room,orgId);
    if (!call || event.room?.sid && call.room_sid && event.room.sid !== call.room_sid) return;
    const inserted = await run(tx, `INSERT INTO client_call_provider_events(id,org_id,call_id,event_type,received_at)
      VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,event.id,call.org_id,call.id,event.event,now());
    if (!inserted.count) return;
    if (event.event === "egress_started" && event.egressInfo?.egressId) {
      await providerCall(() => egressClient(provider).stopEgress(event.egressInfo!.egressId));
      await callAudit(tx,call,"Unexpected recording stopped for client call");
      return;
    }
    if (event.event === "room_finished") {
      if (call.status === "Connected") await finish(tx,call,"Ended");
      if (call.status === "Accepted") await run(tx,`UPDATE client_calls SET room_created_at=NULL,room_sid=NULL,client_sid=NULL,staff_sid=NULL,
        client_signal_at=NULL,staff_signal_at=NULL WHERE id=?`,call.id);
      else await run(tx,"UPDATE client_calls SET room_closed_at=COALESCE(room_closed_at,?) WHERE id=?",now(),call.id);
      return;
    }
    const participant = event.participant;
    if (!participant?.identity || !participant.sid) return;
    const side = participant.identity === participantIdentity(call,"client") ? "client"
      : participant.identity === participantIdentity(call,"staff") ? "staff" : null;
    if (event.event === "participant_joined") {
      if (!side || participant.kind === ParticipantInfo_Kind.EGRESS || (call.status !== "Accepted" && call.status !== "Connected")
        || !call.room_created_at || !await isAuthorized(tx,call) || deadlineStatus(call,now())) {
        try { await roomClient(provider).removeParticipant(room,participant.identity); }
        catch (failure) { if (!isMissing(failure)) return fail(502,"Could not revoke unauthorized call media access."); }
        return;
      }
      await applyPresence(tx,call,side === "client" ? participant.sid : call.client_sid,side === "staff" ? participant.sid : call.staff_sid);
    } else if (side && (call.status === "Accepted" || call.status === "Connected")) {
      await applyPresence(tx,call,side === "client" && call.client_sid === participant.sid ? null : call.client_sid,
        side === "staff" && call.staff_sid === participant.sid ? null : call.staff_sid);
    }
    if (side) await run(tx,`UPDATE client_calls SET ${side === "client" ? "client_signal_at" : "staff_signal_at"}=? WHERE id=?`,now(),call.id);
  });
  return json({ok:true});
}
