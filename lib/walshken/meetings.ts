import { ParticipantInfo_Kind } from "@livekit/protocol";
import { EgressStatus, EncodedFileType, FileOutput, Output, S3Upload, StartEgressRequest, StorageConfig, TemplateSource, WebhookReceiver, type EgressInfo } from "livekit-server-sdk";
import { teamOptions } from "./collaboration";
import { deleteRecordingObject, egressClient, isMissing, liveKitSettings, participantToken, providerCall, publishSources, recordingStorage, roomClient, signedRecording } from "./livekit";
import {integrationSettings} from './integration-settings';
import { all, audit, canManage, colleague, datetime, fail, id, integer, json, notify, now, one, pick, requireStaff, requireSuper, run, stmt, str, throttle, type Actor, type Db, type Row } from "./server";

type Meeting={id:string;org_id:string;organizer_id:string;title:string;starts_at:string;ends_at:string;cancelled_at:string|null;
  provider_room:string|null;provider:string;mode:string;waiting_room:number;screen_sharing:string;ended_at:string|null;
  started_at:string|null;locked_at:string|null;recording_enabled:number;recording_retention_days:number;
  requested_at:string|null;admitted_at:string|null;removed_at:string|null;can_publish:number;can_share:number;co_host:number;recording_consent:number|null;};
type Policy={external_meetings:number;recording_policy:string;recording_retention_days:number};
type Recording={id:string;egress_id:string|null;status:string;object_key:string;expires_at:string};
const roomName=(meeting:string)=>`wk-${meeting}`;
const linkTo=(meeting:string)=>`/staff/calls?meeting=${encodeURIComponent(meeting)}`;
const isAdmin=(actor:Actor)=>actor.role==="super_admin"||actor.role==="admin";
const hostFor=(actor:Actor,m:Meeting)=>m.organizer_id===actor.id||!!m.co_host;
const activeRecording=async(db:Db,meeting:string)=>one<Recording>(db,"SELECT * FROM meeting_recordings WHERE meeting_id=? AND status IN ('Starting','Active','Stopping') ORDER BY created_at DESC LIMIT 1",meeting);
async function policy(db:Db,org:string){const p=await one<Policy>(db,"SELECT external_meetings,recording_policy,recording_retention_days FROM organizations WHERE id=?",org);if(!p)return fail(404,"Workspace is unavailable.");return p;}
const mayRecord=(actor:Actor,m:Meeting,p:Policy)=>p.recording_policy!=="Disabled"&&(isAdmin(actor)||(p.recording_policy==="Hosts"&&hostFor(actor,m)&&canManage(actor)));
async function permittedParticipant(db:Db,actor:Actor,employee:string,p:Policy){
  if(isAdmin(actor)&&p.external_meetings&&await one(db,"SELECT id FROM employees WHERE id=? AND org_id=? AND role='guest' AND status='Active' AND employment_status<>'Ended'",employee,actor.org_id))return;
  const person=await colleague(db,actor,employee);if(person.employment_status==="Ended")return fail(404,"Participant is unavailable.");
}
async function meetingFor(db:Db,actor:Actor,target:string,lock=false){
  const m=await one<Meeting>(db,`SELECT m.*,p.requested_at,p.admitted_at,p.removed_at,p.can_publish,p.can_share,p.co_host,p.recording_consent FROM meetings m
    JOIN meeting_members p ON p.meeting_id=m.id WHERE m.id=? AND m.org_id=? AND p.employee_id=? ${lock?"FOR UPDATE OF m":""}`,target,actor.org_id,actor.id);
  if(!m||m.removed_at||m.provider!=="livekit"||(actor.role==="guest"&&!(await policy(db,actor.org_id)).external_meetings))return fail(404,"Meeting is unavailable.");
  return m;
}
function assertOpen(m:Meeting){if(m.cancelled_at||m.ended_at)return fail(409,"This meeting has ended or was cancelled.");if(Date.now()<Date.parse(m.starts_at)-900000||Date.now()>=Date.parse(m.ends_at))return fail(409,"You can join from 15 minutes before the scheduled start until the scheduled end.");}
async function removeRemote(db:Db,room:string,identity:string){
  const c=roomClient(await liveKitSettings(db));
  await providerCall(async()=>{try{await c.removeParticipant(room,identity,{revokeTokenTs:BigInt(Math.floor(Date.now()/1000)+1)});}catch(e){if(!isMissing(e))throw e;}});
}
async function closeRecording(db:Db,m:Pick<Meeting,"id"> & {provider_room?:string|null}){
  if("provider_room" in m && m.provider_room)await reconcileRecordings(db,m.id,String(m.provider_room));
  const recording=await activeRecording(db,m.id);if(!recording||recording.status==="Stopping")return;
  if(!recording.egress_id)return fail(409,"Recording is still being created. Try again shortly.");
  const info=await providerCall(()=>egressClientSettings(db,recording.egress_id!));
  await updateEgress(db,info);
}
async function egressClientSettings(db:Db,egress:string){return egressClient(await liveKitSettings(db)).stopEgress(egress);}
async function closeMeeting(db:Db,m:Meeting,reason:string,actor?:Actor){
  await closeRecording(db,m);
  if(m.provider_room){const c=roomClient(await liveKitSettings(db));await providerCall(async()=>{try{await c.deleteRoom(m.provider_room!);}catch(e){if(!isMissing(e))throw e;}});}
  const at=now();
  await run(db,"UPDATE meetings SET ended_at=COALESCE(ended_at,?),end_reason=? WHERE id=?",at,reason,m.id);
  await run(db,"UPDATE meeting_attendance SET left_at=?,reason=? WHERE meeting_id=? AND left_at IS NULL",at,reason,m.id);
  if(actor)await audit(db,actor,"Meeting ended","meeting",m.id).run();
}
export async function meetings(db:Db,actor:Actor){
  const p=await policy(db,actor.org_id);if(actor.role==="guest"&&!p.external_meetings)return [];
  return all<Row>(db,`SELECT m.id,m.title,m.starts_at,m.ends_at,m.started_at,m.ended_at,m.mode,m.waiting_room,m.organizer_id,m.cancelled_at,m.locked_at,m.recording_enabled,e.name AS organizer,
    p.requested_at,p.admitted_at,p.co_host FROM meetings m JOIN meeting_members p ON p.meeting_id=m.id JOIN employees e ON e.id=m.organizer_id
    WHERE m.org_id=? AND p.employee_id=? AND p.removed_at IS NULL AND m.provider='livekit' ORDER BY m.starts_at DESC LIMIT 100`,actor.org_id,actor.id);
}
export async function meetingViews(db:Db,actor:Actor){
  const p=await policy(db,actor.org_id),staff=await teamOptions(db,actor);
  if(isAdmin(actor)&&p.external_meetings)staff.push(...await all<Row>(db,"SELECT id,name || ' (guest)' AS name FROM employees WHERE org_id=? AND status='Active' AND employment_status<>'Ended' AND role='guest' ORDER BY name",actor.org_id));
  const [rows,provider,storage]=await Promise.all([meetings(db,actor),integrationSettings(db,'livekit'),integrationSettings(db,'recording-storage')]);
  return json({rows,staff,guestMeetings:!!p.external_meetings,provider:!!provider,recordingStorage:!!storage,meetingPolicy:isAdmin(actor)?p:{recording_policy:p.recording_policy,recording_retention_days:p.recording_retention_days}});
}
async function syncRoom(db:Db,m:Meeting){
  if(m.ended_at||m.cancelled_at||!m.provider_room)return;
  if(m.ends_at<=now()){await closeMeeting(db,m,"Scheduled time reached");return;}
  // Signed events provide history; the API also enforces current suspension, guest policy and consent on reconnects.
  const c=roomClient(await liveKitSettings(db)),participants=await providerCall(async()=>{try{return await c.listParticipants(m.provider_room!);}catch(e){if(isMissing(e))return [];throw e;}});
  await reconcileRecordings(db,m.id,m.provider_room);
  const p=await policy(db,m.org_id);
  const admitted=await all<{employee_id:string;admitted_at:string|null;co_host:number;recording_consent:number|null}>(db,`SELECT p.employee_id,p.admitted_at,p.co_host,p.recording_consent FROM meeting_members p JOIN employees e ON e.id=p.employee_id
    WHERE p.meeting_id=? AND p.removed_at IS NULL AND e.status='Active' AND e.employment_status<>'Ended' AND (?=1 OR e.role<>'guest')`,m.id,p.external_meetings);
  const recording=await activeRecording(db,m.id);
  for(const participant of participants){
    if(participant.kind===ParticipantInfo_Kind.EGRESS)continue;
    const member=admitted.find(row=>row.employee_id===participant.identity);
    if(!member||(m.waiting_room&&participant.identity!==m.organizer_id&&!member.co_host&&!member.admitted_at)||(recording&&member.recording_consent!==1))await removeRemote(db,m.provider_room,participant.identity);
  }
}
export async function meetingDetail(db:Db,actor:Actor,target:string){
  let m=await meetingFor(db,actor,target);await syncRoom(db,m);m=await meetingFor(db,actor,target);
  const p=await policy(db,actor.org_id),host=hostFor(actor,m);
  const members=await all(db,`SELECT p.employee_id AS id,e.name,e.role,p.requested_at,p.admitted_at,p.removed_at,p.co_host,p.can_publish,p.can_share,p.recording_consent,
    EXISTS(SELECT 1 FROM meeting_attendance a WHERE a.meeting_id=p.meeting_id AND a.employee_id=p.employee_id AND a.left_at IS NULL) AS connected
    FROM meeting_members p JOIN employees e ON e.id=p.employee_id WHERE p.meeting_id=? ORDER BY e.name`,m.id);
  const recordings=host||isAdmin(actor)?await all(db,"SELECT id,status,started_at,ended_at,expires_at,deleted_at FROM meeting_recordings WHERE meeting_id=? ORDER BY created_at DESC",m.id):[];
  const report=host||isAdmin(actor)?await attendanceRows(db,m.id):[];
  const active=await activeRecording(db,m.id);
  return json({meeting:m,members,recordings,attendance:report,host,canRecord:!!m.recording_enabled&&mayRecord(actor,m,p),recordingActive:!!active,
    consentText:`I agree to this meeting being recorded, including my voice, video and shared screen. The recording will be accessible to authorized hosts and administrators and retained for ${m.recording_retention_days} days.`});
}
async function attendanceRows(db:Db,meeting:string){
  return all(db,`SELECT e.id,e.employee_no,e.name,MIN(a.joined_at) AS first_join,MAX(a.left_at) AS last_leave,
    COUNT(a.joined_at)::int AS connections,COALESCE(SUM(CASE WHEN a.joined_at IS NOT NULL THEN GREATEST(0,EXTRACT(EPOCH FROM COALESCE(a.left_at,?)::timestamptz-a.joined_at::timestamptz)) ELSE 0 END),0)::int AS seconds,
    BOOL_OR(a.joined_at IS NOT NULL AND a.left_at IS NULL) AS connected
    FROM meeting_members p JOIN employees e ON e.id=p.employee_id LEFT JOIN meeting_attendance a ON a.meeting_id=p.meeting_id AND a.employee_id=p.employee_id
    WHERE p.meeting_id=? GROUP BY e.id,e.employee_no,e.name ORDER BY e.name`,now(),meeting);
}
export async function attendanceReport(db:Db,actor:Actor,target:string){
  const m=await meetingFor(db,actor,target);if(!hostFor(actor,m)&&!isAdmin(actor))return fail(403,"Only authorized hosts and administrators can export attendance.");
  await syncRoom(db,m);
  const rows=await attendanceRows(db,target);
  const cell=(value:unknown)=>'"'+String(value??"").replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';
  const csv=[["Employee ID","Name","First joined UTC","Last left UTC","Connections","Duration seconds","Currently connected"],...rows.map(r=>[r.employee_no,r.name,r.first_join,r.last_leave,r.connections,r.seconds,r.connected])].map(row=>row.map(cell).join(",")).join("\r\n");
  await audit(db,actor,"Meeting attendance exported","meeting",target).run();
  return new Response(csv,{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":'attachment; filename="meeting-attendance.csv"',"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
}
export async function meetingAction(db:Db,actor:Actor,action:string,data:Record<string,unknown>){
  await throttle(db,`calls:${actor.id}`,120,60000);
  if(action==="policy"||action==="guest-policy"){
    requireSuper(actor);
    const p=await policy(db,actor.org_id);
    const external=pick(data.enabled??String(p.external_meetings),["0","1"],"external invitations")==="1"?1:0;
    const recording=pick(data.recordingPolicy??p.recording_policy,["Disabled","Admins","Hosts"],"recording permissions");
    const retention=integer(data.retention??p.recording_retention_days,"recording retention days",1,365);
    if(p.external_meetings&&!external){
      const guests=await all<{meeting_id:string;employee_id:string;provider_room:string|null}>(db,`SELECT p.meeting_id,p.employee_id,m.provider_room FROM meeting_members p JOIN meetings m ON m.id=p.meeting_id JOIN employees e ON e.id=p.employee_id
        WHERE m.org_id=? AND e.role='guest' AND p.removed_at IS NULL AND m.ended_at IS NULL`,actor.org_id);
      for(const guest of guests)if(guest.provider_room)await removeRemote(db,guest.provider_room,guest.employee_id);
      await run(db,`UPDATE meeting_members SET removed_at=? WHERE id IN (SELECT p.id FROM meeting_members p JOIN employees e ON e.id=p.employee_id JOIN meetings m ON m.id=p.meeting_id WHERE e.role='guest' AND m.org_id=?)`,now(),actor.org_id);
    }
    if(recording==="Disabled")for(const m of await all<Meeting>(db,"SELECT * FROM meetings WHERE org_id=? AND ended_at IS NULL",actor.org_id))await closeRecording(db,m);
    await db.batch([stmt(db,"UPDATE organizations SET external_meetings=?,recording_policy=?,recording_retention_days=? WHERE id=?",external,recording,retention,actor.org_id),audit(db,actor,"Calling and recording policy updated","organization",actor.org_id)]);
    return json({ok:true,message:"Calling policy saved. Existing recording retention dates remain as consented."});
  }
  if(action==="schedule"||action==="start"){
    requireStaff(actor);
    if(!Array.isArray(data.members)||data.members.length>99)return fail(400,"Choose up to 99 invited participants.");
    const participants=[...new Set(data.members.map(v=>str(v,"participant",80)))].filter(person=>person!==actor.id);
    if(!participants.length)return fail(400,"Invite at least one participant.");
    const size=pick(data.type??"Group",["One-to-one","Group"],"call size");if(size==="One-to-one"&&participants.length!==1)return fail(400,"Choose exactly one participant.");
    const p=await policy(db,actor.org_id);for(const person of participants)await permittedParticipant(db,actor,person,p);
    if(action==="start")await liveKitSettings(db);
    const start=action==="start"?now():datetime(data.startsAt,"meeting start"),end=action==="start"?new Date(Date.now()+3600000).toISOString():datetime(data.endsAt,"meeting end");
    if(end<=start||end<=now()||Date.parse(end)-Date.parse(start)>43200000)return fail(400,"Choose a future end time within 12 hours of the start.");
    const mode=pick(data.mode??"Video",["Audio","Video"],"call mode"),waiting=pick(data.waiting??"0",["0","1"],"waiting room")==="1"?1:0;
    const sharing=pick(data.screenSharing??"Everyone",["Everyone","Host","Disabled"],"screen sharing");
    const record=pick(data.recording??"0",["0","1"],"optional recording")==="1"?1:0;
    if(record&&(p.recording_policy==="Disabled"||(!isAdmin(actor)&&!(p.recording_policy==="Hosts"&&canManage(actor)))))return fail(403,"Your role is not authorized to create a recordable meeting.");
    if(record)await recordingStorage(db);
    const target=id(),title=str(data.title,"meeting title",100);
    await db.batch([stmt(db,`INSERT INTO meetings (id,org_id,organizer_id,title,starts_at,ends_at,mode,waiting_room,screen_sharing,provider,recording_enabled,recording_retention_days) VALUES (?,?,?,?,?,?,?,?,?,'livekit',?,?)`,target,actor.org_id,actor.id,title,start,end,mode,waiting,sharing,record,p.recording_retention_days),
      ...[actor.id,...participants].map(person=>stmt(db,"INSERT INTO meeting_members (id,meeting_id,employee_id) VALUES (?,?,?)",id(),target,person)),
      ...participants.map(person=>notify(db,person,action==="start"?"Incoming call":"Meeting scheduled",title,linkTo(target))),audit(db,actor,action==="start"?"Instant call created":"Meeting scheduled","meeting",target)]);
    return json({ok:true,id:target,message:action==="start"?"Call invitation sent.":"Meeting scheduled."},201);
  }
  const target=str(data.id,"meeting",80);
  if(action==="record-start")return await startRecording(db,actor,target);
  return db.transaction(async tx=>{
    const m=await meetingFor(tx,actor,target,true),p=await policy(tx,actor.org_id),host=hostFor(actor,m);
    if(action==="cancel"||action==="end"){
      if(!host)return fail(403,"Only a host can end this meeting.");
      if(action==="cancel"&&m.started_at)return fail(409,"This meeting has started. Use End for everyone.");
      await closeMeeting(tx,m,action==="cancel"?"Cancelled":"Ended by host",actor);
      if(action==="cancel")await run(tx,"UPDATE meetings SET cancelled_at=? WHERE id=?",now(),target);
      return json({ok:true,message:action==="cancel"?"Meeting cancelled.":"Meeting ended for everyone."});
    }
    if(action==="download-recording"||action==="delete-recording"){
      if(!host&&!isAdmin(actor))return fail(403,"Recording access is restricted to authorized hosts and administrators.");
      const recording=await one<Recording>(tx,"SELECT * FROM meeting_recordings WHERE id=? AND meeting_id=? AND deleted_at IS NULL",str(data.recording,"recording",80),target);
      if(!recording)return fail(404,"Recording not found.");
      if(action==="delete-recording"){
        if(!isAdmin(actor))return fail(403,"Only administrators can delete recordings.");
        if(["Starting","Active","Stopping"].includes(recording.status))return fail(409,"Stop the recording before deleting it.");
        await deleteRecordingObject(tx,recording.object_key);await run(tx,"UPDATE meeting_recordings SET status='Deleted',deleted_at=? WHERE id=?",now(),recording.id);
      }else{
        if(recording.status!=="Complete"||recording.expires_at<=now())return fail(410,"This recording is unavailable or its retention period has ended.");
        const seconds=Math.max(1,Math.min(60,Math.floor((Date.parse(recording.expires_at)-Date.now())/1000)));
        const url=await signedRecording(tx,recording.object_key,seconds);await audit(tx,actor,"Recording download authorized","meeting recording",recording.id).run();return json({ok:true,url});
      }
      await audit(tx,actor,"Meeting recording deleted","meeting recording",recording.id).run();return json({ok:true,message:"Recording permanently deleted from private storage."});
    }
    assertOpen(m);
    if(action==="consent"){
      if(!m.recording_enabled)return fail(409,"Recording is disabled for this meeting.");
      const consent=pick(data.consent,["0","1"],"recording consent")==="1"?1:0;
      if(!consent)await closeRecording(tx,m);
      await run(tx,"UPDATE meeting_members SET recording_consent=?,consent_at=? WHERE meeting_id=? AND employee_id=?",consent,now(),target,actor.id);
      await audit(tx,actor,consent?"Recording consent given":"Recording consent declined or withdrawn","meeting",target).run();
      return json({ok:true,message:consent?"Your recording consent was saved.":"Recording consent declined. Any active recording has been stopped."});
    }
    if(action==="lock"){
      if(!host)return fail(403,"Only a host can lock this meeting.");
      await run(tx,"UPDATE meetings SET locked_at=? WHERE id=?",data.locked==="1"?now():null,target);await audit(tx,actor,data.locked==="1"?"Meeting locked":"Meeting unlocked","meeting",target).run();
      return json({ok:true,message:data.locked==="1"?"New joins are locked.":"Meeting unlocked."});
    }
    if(action==="invite"){
      if(!host||actor.role==="guest")return fail(403,"Only an internal host can invite participants.");
      if(await activeRecording(tx,target))return fail(409,"Stop recording before changing the participant list. New participants must give their own consent.");
      const person=str(data.employee,"participant",80);await permittedParticipant(tx,actor,person,p);
      const count=await one<{n:number}>(tx,"SELECT count(*)::int AS n FROM meeting_members WHERE meeting_id=? AND removed_at IS NULL",target);if((count?.n??0)>=100)return fail(409,"This meeting supports up to 100 invited participants.");
      await run(tx,`INSERT INTO meeting_members (id,meeting_id,employee_id) VALUES (?,?,?) ON CONFLICT(meeting_id,employee_id) DO UPDATE SET removed_at=NULL,requested_at=NULL,admitted_at=NULL,co_host=0,can_publish=1,can_share=1,recording_consent=NULL,consent_at=NULL`,id(),target,person);
      await notify(tx,person,"Meeting invitation",m.title,linkTo(target)).run();await audit(tx,actor,"Meeting participant invited","meeting",`${target}/${person}`).run();return json({ok:true,message:"Participant invited."});
    }
    if(["admit","deny","remove","permissions","mute"].includes(action)){
      if(!host)return fail(403,"Only hosts can manage participants.");
      const person=str(data.employee,"participant",80),member=await one<{co_host:number;requested_at:string|null}>(tx,"SELECT co_host,requested_at FROM meeting_members WHERE meeting_id=? AND employee_id=? AND removed_at IS NULL",target,person);
      if(!member)return fail(404,"Participant not found.");
      if(person===m.organizer_id||person===actor.id||(member.co_host&&actor.id!==m.organizer_id))return fail(403,"A host cannot change this participant's access.");
      if(action==="admit"){
        if(!m.waiting_room||!member.requested_at)return fail(409,"This participant is not waiting.");
        if(m.locked_at)return fail(409,"Unlock the meeting before admitting a new participant.");
        await run(tx,"UPDATE meeting_members SET admitted_at=? WHERE meeting_id=? AND employee_id=?",now(),target,person);
        await notify(tx,person,"Meeting access approved",m.title,linkTo(target)).run();
      }else if(action==="deny"||action==="remove"){
        if(m.provider_room)await removeRemote(tx,m.provider_room,person);
        await run(tx,"UPDATE meeting_members SET removed_at=? WHERE meeting_id=? AND employee_id=?",now(),target,person);
      }else if(action==="permissions"){
        const publish=pick(data.publish,["0","1"],"microphone and camera permission")==="1"?1:0,share=pick(data.share,["0","1"],"screen sharing permission")==="1"?1:0;
        const cohost=pick(data.coHost??String(member.co_host),["0","1"],"co-host access")==="1"?1:0;
        if(actor.id!==m.organizer_id&&cohost!==member.co_host)return fail(403,"Only the organizer can assign co-host access.");
        const personInfo=await one<{role:string;status:string}>(tx,"SELECT role,status FROM employees WHERE id=? AND org_id=?",person,actor.org_id);
        if(cohost&&(personInfo?.role==="guest"||personInfo?.status!=="Active"))return fail(403,"Co-hosts must be active internal staff.");
        if(m.provider_room){
          const c=roomClient(await liveKitSettings(tx)),sources=publishSources(m.mode,m.screen_sharing,publish,share,!!cohost);
          await providerCall(async()=>{try{await c.updateParticipant(m.provider_room!,person,{permission:{canSubscribe:true,canPublish:sources.length>0,canPublishSources:sources,canPublishData:false,canUpdateMetadata:false}});}catch(e){if(!isMissing(e))throw e;}});
        }
        await run(tx,"UPDATE meeting_members SET can_publish=?,can_share=?,co_host=? WHERE meeting_id=? AND employee_id=?",publish,share,cohost,target,person);
      }else if(m.provider_room){
        const c=roomClient(await liveKitSettings(tx));await providerCall(async()=>{const participant=await c.getParticipant(m.provider_room!,person);for(const track of participant.tracks)if(track.type===0)await c.mutePublishedTrack(m.provider_room!,person,track.sid,true);});
      }
      await audit(tx,actor,`Meeting participant ${action}`,"meeting",`${target}/${person}`).run();return json({ok:true,message:"Participant access updated."});
    }
    if(action==="record-stop"){
      if(!mayRecord(actor,m,p))return fail(403,"Your role is not authorized to control recordings.");
      await closeRecording(tx,m);await audit(tx,actor,"Meeting recording stopped","meeting",target).run();return json({ok:true,message:"Recording stop requested."});
    }
    if(action==="withdraw-request"){
      await run(tx,"UPDATE meeting_members SET requested_at=NULL WHERE meeting_id=? AND employee_id=? AND admitted_at IS NULL",target,actor.id);return json({ok:true,message:"Entry request withdrawn."});
    }
    if(action==="leave"){
      if(m.provider_room)await removeRemote(tx,m.provider_room,actor.id);
      return json({ok:true});
    }
    if(action!=="join")return fail(404,"Meeting action unavailable.");
    if(m.locked_at&&!host)return fail(409,"The host has locked this meeting.");
    const settings=await liveKitSettings(tx);
    if(await activeRecording(tx,target)&&m.recording_consent!==1)return fail(409,"Recording is active. Give consent or ask the host to stop recording before joining.");
    if(!host&&m.waiting_room&&!m.admitted_at){
      if(!m.requested_at){await run(tx,"UPDATE meeting_members SET requested_at=? WHERE meeting_id=? AND employee_id=?",now(),target,actor.id);await notify(tx,m.organizer_id,"Participant waiting to join",actor.name,linkTo(target)).run();}
      return json({ok:true,waiting:true,message:"Waiting for a host to admit you."},202);
    }
    const room=m.provider_room??roomName(target),c=roomClient(settings);
    await providerCall(()=>c.createRoom({name:room,emptyTimeout:300,departureTimeout:30,maxParticipants:102,metadata:JSON.stringify({meeting:target,endsAt:m.ends_at})}));
    await run(tx,"UPDATE meetings SET provider_room=? WHERE id=?",room,target);
    const sources=publishSources(m.mode,m.screen_sharing,m.can_publish,m.can_share,host);
    const token=await participantToken(settings,room,actor.id,actor.name,sources,m.ends_at);
    await audit(tx,actor,"LiveKit join authorized","meeting",target).run();
    return json({ok:true,token,serverUrl:settings.url,mode:m.mode,endsAt:m.ends_at,canPublish:!!m.can_publish});
  });
}

async function startRecording(db:Db,actor:Actor,target:string){
  const intent=await db.transaction(async tx=>{
    const m=await meetingFor(tx,actor,target,true),p=await policy(tx,actor.org_id);assertOpen(m);
    if(!m.recording_enabled||!mayRecord(actor,m,p))return fail(403,"Your role is not authorized to record this meeting.");
    if(await activeRecording(tx,target))return fail(409,"A recording is already active or processing.");
    if(await one(tx,"SELECT id FROM meeting_members WHERE meeting_id=? AND removed_at IS NULL AND COALESCE(recording_consent,0)<>1 LIMIT 1",target))
      return fail(409,"Every invited participant must give their own recording consent before recording starts.");
    if(!m.provider_room||!m.started_at)return fail(409,"Join the meeting before starting a recording.");
    const storage=await recordingStorage(tx),settings=await liveKitSettings(tx),recording=id();
    const key=`walshken/meetings/${target}/${recording}.mp4`,expires=new Date(Date.now()+m.recording_retention_days*86400000).toISOString();
    await run(tx,"INSERT INTO meeting_recordings (id,meeting_id,created_by,object_key,status,expires_at) VALUES (?,?,?,?,'Starting',?)",recording,target,actor.id,key,expires);
    await audit(tx,actor,"Meeting recording requested with unanimous consent","meeting recording",recording).run();
    return {m,storage,settings,recording,key};
  });
  // Persist intent before contacting Egress so a timeout or process restart can be reconciled safely.
  const {m,storage,settings,recording,key}=intent;
  const request=new StartEgressRequest({roomName:m.provider_room!,source:{case:"template",value:new TemplateSource({layout:"grid",audioOnly:m.mode==="Audio"})},
    outputs:[new Output({config:{case:"file",value:new FileOutput({filepath:key,fileType:EncodedFileType.MP4,disableManifest:true})}})],
    storage:new StorageConfig({provider:{case:"s3",value:new S3Upload({endpoint:storage.endpoint,region:storage.region,bucket:storage.bucket,accessKey:storage.accessKey,secret:storage.secretKey,forcePathStyle:true})}})});
  const info=await providerCall(()=>egressClient(settings).startEgress(request));
  await run(db,"UPDATE meeting_recordings SET egress_id=? WHERE id=? AND egress_id IS NULL",info.egressId,recording);
  await updateEgress(db,info);
  return json({ok:true,message:"Recording requested. The meeting will show its recording status."});
}
async function reconcileRecordings(db:Db,meeting:string,room:string){
  const recordings=await all<Recording & {created_at:string}>(db,"SELECT * FROM meeting_recordings WHERE meeting_id=? AND status IN ('Starting','Active','Stopping')",meeting);
  if(!recordings.length)return;
  const remote=await providerCall(async()=>egressClient(await liveKitSettings(db)).listEgress({roomName:room}));
  for(const recording of recordings){
    const info=remote.find(e=>e.egressId===recording.egress_id||(!recording.egress_id&&e.request.case==="egress"&&e.request.value.outputs.some(output=>output.config.case==="file"&&output.config.value.filepath===recording.object_key)));
    if(info){await run(db,"UPDATE meeting_recordings SET egress_id=? WHERE id=? AND egress_id IS NULL",info.egressId,recording.id);await updateEgress(db,info);}
    else if(!recording.egress_id&&Date.now()-Date.parse(recording.created_at)>300000)await run(db,"UPDATE meeting_recordings SET status='Failed',ended_at=? WHERE id=? AND egress_id IS NULL",now(),recording.id);
  }
}

async function updateEgress(db:Db,info:EgressInfo){
  const status=info.status===EgressStatus.EGRESS_COMPLETE?"Complete":info.status===EgressStatus.EGRESS_FAILED||info.status===EgressStatus.EGRESS_ABORTED||info.status===EgressStatus.EGRESS_LIMIT_REACHED?"Failed":info.status===EgressStatus.EGRESS_ENDING?"Stopping":info.status===EgressStatus.EGRESS_ACTIVE?"Active":"Starting";
  const stamp=(value:bigint)=>value>0n?new Date(Number(value/1000000n)).toISOString():null;
  await run(db,"UPDATE meeting_recordings SET status=?,started_at=COALESCE(started_at,?),ended_at=COALESCE(ended_at,?) WHERE egress_id=? AND status<>'Deleted'",status,stamp(info.startedAt),stamp(info.endedAt),info.egressId);
}
export async function liveKitWebhook(db:Db,request:Request){
  const length=Number(request.headers.get("content-length")??0);if(length>262144)return fail(413,"Webhook payload too large.");
  const reader=request.body?.getReader();if(!reader)return fail(400,"Webhook payload is required.");
  const chunks:Uint8Array[]=[];let bytes=0;
  for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>262144){await reader.cancel();return fail(413,"Webhook payload too large.");}chunks.push(item.value);}
  const raw=Buffer.concat(chunks).toString("utf8");
  const settings=await liveKitSettings(db);let event;
  try{event=await new WebhookReceiver(settings.apiKey,settings.apiSecret).receive(raw,request.headers.get("authorization")??"");}catch{return fail(401,"Invalid LiveKit webhook signature.");}
  const room=event.room?.name??event.egressInfo?.roomName;
  if(!event.id||!room)return json({ok:true});
  const found=await one<Meeting>(db,"SELECT * FROM meetings WHERE provider='livekit' AND provider_room=?",room);if(!found)return json({ok:true});
  await db.transaction(async tx=>{
    const m=await one<Meeting>(tx,"SELECT * FROM meetings WHERE id=? FOR UPDATE",found.id);if(!m)return;
    const inserted=await run(tx,"INSERT INTO meeting_events (id,meeting_id,event) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING",event.id,m.id,event.event);if(!inserted.count)return;
    const at=new Date(Number(event.createdAt)*1000).toISOString();
    if(event.event==="participant_joined"&&event.participant?.kind!==ParticipantInfo_Kind.EGRESS){
      const participant=event.participant;if(!participant?.sid||!participant.identity)return;
      const p=await policy(tx,m.org_id),member=await one<{employee_id:string;admitted_at:string|null;co_host:number;recording_consent:number|null}>(tx,`SELECT p.employee_id,p.admitted_at,p.co_host,p.recording_consent FROM meeting_members p JOIN employees e ON e.id=p.employee_id WHERE p.meeting_id=? AND p.employee_id=? AND p.removed_at IS NULL AND e.status='Active' AND e.employment_status<>'Ended' AND (?=1 OR e.role<>'guest')`,m.id,participant.identity,p.external_meetings);
      if(!member||m.ended_at||m.cancelled_at||m.ends_at<=now()||(m.locked_at&&participant.identity!==m.organizer_id&&!member.co_host&&!await one(tx,"SELECT id FROM meeting_attendance WHERE participant_sid=? AND left_at IS NULL",participant.sid))||(m.waiting_room&&participant.identity!==m.organizer_id&&!member.co_host&&!member.admitted_at)||((await activeRecording(tx,m.id))&&member.recording_consent!==1)){await removeRemote(tx,room,participant.identity);return;}
      const joined=participant.joinedAt>0n?new Date(Number(participant.joinedAt)*1000).toISOString():at;
      await run(tx,`INSERT INTO meeting_attendance (id,meeting_id,employee_id,participant_sid,joined_at) VALUES (?,?,?,?,?) ON CONFLICT(participant_sid) DO UPDATE SET joined_at=COALESCE(meeting_attendance.joined_at,excluded.joined_at)`,id(),m.id,participant.identity,participant.sid,joined);
      await run(tx,"UPDATE meetings SET started_at=CASE WHEN started_at IS NULL OR started_at>? THEN ? ELSE started_at END WHERE id=?",joined,joined,m.id);
    }
    if(["participant_left","participant_connection_aborted"].includes(event.event)&&event.participant?.kind!==ParticipantInfo_Kind.EGRESS){
      const participant=event.participant;if(participant?.sid&&await one(tx,"SELECT id FROM meeting_members WHERE meeting_id=? AND employee_id=?",m.id,participant.identity))
        await run(tx,`INSERT INTO meeting_attendance (id,meeting_id,employee_id,participant_sid,left_at,reason) VALUES (?,?,?,?,?,?) ON CONFLICT(participant_sid) DO UPDATE SET left_at=COALESCE(meeting_attendance.left_at,excluded.left_at),reason=excluded.reason`,id(),m.id,participant.identity,participant.sid,at,event.event);
    }
    if(event.event==="room_finished"){
      await run(tx,"UPDATE meeting_attendance SET left_at=COALESCE(left_at,?),reason=COALESCE(reason,'Room finished') WHERE meeting_id=?",at,m.id);
      const last=await one<{last:string|null}>(tx,"SELECT MAX(left_at) AS last FROM meeting_attendance WHERE meeting_id=?",m.id);
      await run(tx,"UPDATE meetings SET ended_at=COALESCE(ended_at,?),end_reason=COALESCE(end_reason,'Room finished') WHERE id=?",last?.last??at,m.id);
    }
    if(event.egressInfo){
      const info=event.egressInfo;
      if(info.request.case==="egress")for(const output of info.request.value.outputs)if(output.config.case==="file")
        await run(tx,"UPDATE meeting_recordings SET egress_id=? WHERE meeting_id=? AND object_key=? AND egress_id IS NULL",info.egressId,m.id,output.config.value.filepath);
      await updateEgress(tx,info);
    }
  });
  return json({ok:true});
}
export async function maintainMeetings(db:Db){
  const overdue=await all<Meeting>(db,"SELECT * FROM meetings WHERE provider='livekit' AND ended_at IS NULL AND cancelled_at IS NULL AND (provider_room IS NOT NULL OR ends_at<=?) ORDER BY ends_at LIMIT 100",now());
  let ended=0,deleted=0;const errors:string[]=[];
  for(const m of overdue)try{if(m.ends_at<=now()){await db.transaction(tx=>closeMeeting(tx,m,"Scheduled time reached"));ended++;}else await syncRoom(db,m);}catch{errors.push(`meeting:${m.id}`);}
  const processing=await all<{meeting_id:string;provider_room:string}>(db,"SELECT DISTINCT r.meeting_id,m.provider_room FROM meeting_recordings r JOIN meetings m ON m.id=r.meeting_id WHERE r.status IN ('Starting','Active','Stopping') AND m.provider_room IS NOT NULL LIMIT 100");
  for(const item of processing)try{await reconcileRecordings(db,item.meeting_id,item.provider_room);}catch{errors.push(`egress:${item.meeting_id}`);}
  const expired=await all<Recording>(db,"SELECT * FROM meeting_recordings WHERE expires_at<=? AND deleted_at IS NULL AND status NOT IN ('Starting','Active','Stopping') ORDER BY expires_at LIMIT 100",now());
  for(const recording of expired)try{await deleteRecordingObject(db,recording.object_key);await run(db,"UPDATE meeting_recordings SET status='Deleted',deleted_at=? WHERE id=?",now(),recording.id);deleted++;}catch{errors.push(`recording:${recording.id}`);}
  return {ended,deleted,errors};
}
