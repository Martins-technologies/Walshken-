import { all, audit, fail, id, integer, notify, now, one, run, type Actor, type Db } from "./server";

export const recordingRoles = ["super_admin", "admin", "hr", "manager", "employee"] as const;
export const recordingCategories = ["Audio", "Video", "Group"] as const;
export type RecordingRole = typeof recordingRoles[number];
export type RecordingCategory = typeof recordingCategories[number];
export const managementRecordingEnabled = () => process.env.WALSHKEN_MANAGEMENT_RECORDING_ENABLED === "1";
export type RecordingMeeting = { id:string; org_id:string; organizer_id?:string; mode:string; recording_category?:string|null; recording_enabled?:number };
export type RecordingPolicy = {
  enabled:boolean; request_roles:RecordingRole[]; start_roles:RecordingRole[]; categories:RecordingCategory[];
  host_approval:boolean; participant_consent:boolean; retention_days:number; revision:number;
};
type LegacyPolicy = { recording_policy:string; recording_retention_days:number };
type RecordingRequest = {id:string; status:"Pending"|"Approved"|"Declined"|"Used"; requested_by:string; requested_at:string; decided_at:string|null};

export function canManageRecordingPolicy(actor: Actor) {
  if(actor.role==="super_admin")return true;
  if(actor.role!=="admin")return false;
  const matching=(actor.permissions??[]).filter(rule=>rule.action==="calls.recording.policy");
  return matching.some(rule=>rule.scope_type==="organization"&&rule.effect==="allow")&&!matching.some(rule=>rule.effect==="deny");
}

export async function organizationRecordingPolicy(db: Db, org: string, legacy?: LegacyPolicy): Promise<RecordingPolicy> {
  if(managementRecordingEnabled()){
    const settings=await one<RecordingPolicy>(db,"SELECT enabled,request_roles,start_roles,categories,host_approval,participant_consent,retention_days,revision FROM meeting_recording_policies WHERE org_id=? ORDER BY revision DESC LIMIT 1",org);
    if(settings)return settings;
  }
  const fallback=legacy??await one<LegacyPolicy>(db,"SELECT recording_policy,recording_retention_days FROM organizations WHERE id=?",org);
  if(!fallback)return fail(404,"Workspace is unavailable.");
  const roles: RecordingRole[]=fallback.recording_policy==="Hosts"?["super_admin","admin","hr","manager"]:["super_admin","admin"];
  return {enabled:fallback.recording_policy!=="Disabled",request_roles:roles,start_roles:roles,categories:[...recordingCategories],host_approval:false,participant_consent:true,retention_days:fallback.recording_retention_days,revision:0};
}

export function permittedRecordingCategory(m: RecordingMeeting, policy: RecordingPolicy) {
  return policy.enabled&&policy.categories.includes((m.recording_category??m.mode) as RecordingCategory);
}

export async function recordingConsentRequired(db: Db, m: RecordingMeeting) {
  if((await organizationRecordingPolicy(db,m.org_id)).participant_consent)return true;
  return !!await one(db,"SELECT id FROM meeting_recordings WHERE meeting_id=? AND participant_consent_required AND status IN ('Starting','Active','Stopping')",m.id);
}

export async function recordingPermitted(db: Db, m: RecordingMeeting) {
  return !!m.recording_enabled&&permittedRecordingCategory(m,await organizationRecordingPolicy(db,m.org_id));
}

export async function saveRecordingPolicy(db: Db, actor: Actor, data: Record<string,unknown>) {
  if(!managementRecordingEnabled())return fail(404,"Recording policy settings are unavailable.");
  if(!canManageRecordingPolicy(actor))return fail(403,"Organization-wide recording policy authority is required.");
  const toggle=(value:unknown,label:string)=>{
    if(value!==true&&value!==false)return fail(400,`${label} requires an enabled or disabled value.`);
    return value;
  };
  const choices=<T extends string>(raw:unknown,allowed:readonly T[],label:string):T[]=>{
    if(!Array.isArray(raw)||raw.length>allowed.length||raw.some(value=>typeof value!=="string"||!allowed.includes(value as T)))
      return fail(400,`Select valid ${label}.`);
    return allowed.filter(value=>raw.includes(value));
  };
  const enabled=toggle(data.enabled,"Recording"),host=toggle(data.hostApproval,"Host approval"),consent=toggle(data.participantConsent,"Participant consent");
  const request=choices(data.requestRoles,recordingRoles,"request roles"),start=choices(data.startRoles,recordingRoles,"start roles"),categories=choices(data.categories,recordingCategories,"meeting categories");
  const retention=integer(data.retention,"retention days",1,365),revision=integer(data.revision,"policy revision",0,1000000);
  if(enabled&&(!start.length||!categories.length||host&&!request.length))return fail(400,"Enabled recording needs a start role and meeting category. Host approval also needs a request role.");
  return db.transaction(async tx=>{
    await one(tx,"SELECT id FROM organizations WHERE id=? FOR UPDATE",actor.org_id);
    const current=await organizationRecordingPolicy(tx,actor.org_id);
    if(current.revision!==revision)return fail(409,"Recording policy changed. Reload the policy before saving.");
    const result={enabled,request_roles:request,start_roles:start,categories,host_approval:host,participant_consent:consent,retention_days:retention,revision:revision+1};
    await run(tx,`INSERT INTO meeting_recording_policies (org_id,enabled,request_roles,start_roles,categories,host_approval,participant_consent,retention_days,revision,updated_by,updated_at)
      VALUES (?,?,?::text[],?::text[],?::text[],?,?,?,?,?,?)`,actor.org_id,enabled,request,start,categories,host,consent,retention,result.revision,actor.id,now());
    // A legacy deployment must also fail closed after an administrator disables recording.
    if(!enabled)await run(tx,"UPDATE organizations SET recording_policy='Disabled' WHERE id=?",actor.org_id);
    await audit(tx,actor,"Organization recording policy updated","organization",actor.org_id).run();
    const meetings=await all<RecordingMeeting&{provider_room:string|null}>(tx,`SELECT m.id,m.org_id,m.organizer_id,m.mode,m.recording_category,m.provider_room FROM meetings m JOIN meeting_recordings r ON r.meeting_id=m.id
      WHERE m.org_id=? AND r.status IN ('Starting','Active','Stopping') ORDER BY m.id FOR UPDATE OF m`,actor.org_id);
    const affected=meetings.filter(meeting=>!permittedRecordingCategory(meeting,result)||consent&&!current.participant_consent||host&&!current.host_approval);
    for(const meeting of affected)await run(tx,"UPDATE meeting_recordings SET stop_requested_at=COALESCE(stop_requested_at,?) WHERE meeting_id=? AND status IN ('Starting','Active','Stopping')",now(),meeting.id);
    return affected;
  });
}

export async function currentRecordingRequest(db: Db, m: RecordingMeeting, revision: number) {
  if(!revision)return null;
  return one<RecordingRequest>(db,"SELECT id,status,requested_by,requested_at,decided_at FROM meeting_recording_requests WHERE org_id=? AND meeting_id=? AND policy_revision=? ORDER BY (status IN ('Pending','Approved')) DESC,requested_at DESC,id DESC LIMIT 1",m.org_id,m.id,revision);
}

export async function recordRequestAction(db: Db, actor: Actor, m: RecordingMeeting, p: RecordingPolicy, action: string, data: Record<string,unknown>, host: boolean) {
  if(!p.revision||!p.host_approval||!m.recording_enabled||!permittedRecordingCategory(m,p))return fail(409,"Host approval requests are unavailable for this meeting.");
  const request=await currentRecordingRequest(db,m,p.revision);
  const link=`/staff/calls?meeting=${encodeURIComponent(m.id)}`;
  if(action==="record-request"){
    if(!p.request_roles.includes(actor.role as RecordingRole))return fail(403,"Your role cannot request a recording.");
    if(request?.status==="Pending"||request?.status==="Approved")return fail(409,"A recording request is already awaiting a decision or is approved.");
    await run(db,"INSERT INTO meeting_recording_requests (id,org_id,meeting_id,policy_revision,status,requested_by,requested_at) VALUES (?,?,?,?,'Pending',?,?)",id(),m.org_id,m.id,p.revision,actor.id,now());
    const hosts=await all<{id:string}>(db,`SELECT e.id FROM employees e JOIN meeting_members b ON b.employee_id=e.id WHERE b.meeting_id=? AND b.removed_at IS NULL AND e.org_id=? AND e.role<>'guest' AND e.status='Active' AND e.employment_status<>'Ended' AND (e.id=? OR b.co_host=1)`,m.id,m.org_id,m.organizer_id);
    for(const recipient of hosts)if(recipient.id!==actor.id)await notify(db,recipient.id,"Meeting recording approval requested","A participant requested approval to record your meeting.",link).run();
    await audit(db,actor,"Meeting recording approval requested","meeting",m.id).run();
    return "Recording request sent to meeting hosts.";
  }
  if(!host||actor.role==="guest")return fail(403,"Only an internal meeting host can decide a recording request.");
  if(!request||request.status!=="Pending"||data.request!==request.id)return fail(409,"This recording request is no longer pending.");
  const approved=action==="record-approve";
  await run(db,"UPDATE meeting_recording_requests SET status=?,decided_by=?,decided_at=? WHERE id=?",approved?"Approved":"Declined",actor.id,now(),request.id);
  if(request.requested_by!==actor.id)await notify(db,request.requested_by,approved?"Recording request approved":"Recording request declined","A host reviewed your meeting recording request.",link).run();
  await audit(db,actor,approved?"Meeting recording request approved":"Meeting recording request declined","meeting",m.id).run();
  return approved?"Recording approved. An authorized participant can start it when the required consent is in place.":"Recording request declined.";
}
