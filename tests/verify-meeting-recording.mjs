import assert from "node:assert/strict";
import { canManageRecordingPolicy } from "../lib/walshken/meeting-recording-policy.ts";

export async function verifyMeetingRecording({ db, request, admin, staff, staffId, adminId, values, participants, emit, egresses }) {
  const role = {role:"admin",permissions:[]};
  assert.equal(canManageRecordingPolicy(role),false);
  const grant = {action:"calls.recording.policy",scope_type:"organization",effect:"allow",scope_id:""};
  assert.equal(canManageRecordingPolicy({...role,permissions:[grant]}),true);
  assert.equal(canManageRecordingPolicy({...role,permissions:[{...grant,scope_type:"department"}]}),false);
  assert.equal(canManageRecordingPolicy({...role,permissions:[grant,{...grant,effect:"deny"}]}),false);
  assert.equal(canManageRecordingPolicy({role:"hr",permissions:[grant]}),false);

  process.env.WALSHKEN_MANAGEMENT_RECORDING_ENABLED="1";
  const configuration={enabled:true,hostApproval:true,participantConsent:true,requestRoles:["employee"],startRoles:["super_admin"],categories:["Audio"],retention:"3",revision:0};
  assert.equal((await request("view/calls",200,admin)).recordingSettings.revision,0);
  await request("calls/recording-policy",403,staff,configuration);
  await request("calls/recording-policy",400,admin,{...configuration,categories:["Unknown"]});
  await request("calls/recording-policy",200,admin,configuration);
  assert.deepEqual((await request("view/calls",200,staff)).recordingCategories,["Audio"]);
  assert.equal((await request("view/calls",200,staff)).recordingSettings,undefined);
  await request("calls/recording-policy",409,admin,configuration);
  await request("calls/policy",400,admin,{recordingPolicy:"Hosts"});
  await request("calls/schedule",403,admin,{...values,mode:"Video",recording:"1"});
  await request("calls/schedule",403,admin,{...values,type:"Group",recording:"1"});
  const scheduled={...values,title:"Recording approval verification",waiting:"0",recording:"1"};
  const {id:meeting}=await request("calls/schedule",201,admin,scheduled);
  const roomName="wk-"+meeting,who={identity:adminId,name:"Approved host",sid:"PA_managedHost",joinedAt:String(Math.floor(Date.now()/1000)),kind:"STANDARD"};
  await request("calls/join",200,admin,{id:meeting});
  participants.set(roomName,[who]);
  await emit("participant_joined",roomName,who);
  const view=()=>request("meeting/"+meeting,200,admin);
  assert.equal((await view()).meeting.recording_retention_days,3);
  assert.equal((await view()).meeting.recording_category,"Audio");
  await request("calls/record-start",403,staff,{id:meeting});
  await request("calls/record-start",409,admin,{id:meeting});
  await request("calls/record-request",403,admin,{id:meeting});
  await request("calls/record-request",201,staff,{id:meeting});
  const pending=(await view()).recordingRequest;
  await request("calls/record-approve",403,staff,{id:meeting,request:pending.id});
  await request("calls/record-decline",200,admin,{id:meeting,request:pending.id});
  await request("calls/record-request",201,staff,{id:meeting});
  const requested=(await view()).recordingRequest;
  await request("calls/record-approve",409,admin,{id:meeting,request:pending.id});
  await request("calls/record-approve",200,admin,{id:meeting,request:requested.id});
  await request("calls/record-start",409,admin,{id:meeting});
  await request("calls/consent",200,admin,{id:meeting,consent:"1"});
  await request("calls/consent",200,staff,{id:meeting,consent:"1"});
  const before=egresses.size;
  await request("calls/record-start",200,admin,{id:meeting});
  assert.equal(egresses.size,before+1);
  const active=await view();
  assert.equal(active.recordingStatus,"Active");
  assert.equal(active.recordingRequest.status,"Used");
  const recording=active.recordings[0];
  await request("calls/record-stop",403,staff,{id:meeting});
  await request("calls/download-recording",403,staff,{id:meeting,recording:recording.id});
  await request("calls/play-recording",403,staff,{id:meeting,recording:recording.id});
  await request("calls/play-recording",410,admin,{id:meeting,recording:recording.id});
  const fetchLivekit=globalThis.fetch;
  try{
    globalThis.fetch=async (url,options)=>new URL(url).pathname.endsWith("/StopEgress")
      ?Response.json({code:"internal",msg:"Temporary provider outage"},{status:502}):fetchLivekit(url,options);
    assert.equal((await request("calls/consent",200,staff,{id:meeting,consent:"0"})).stopPending,true);
    assert.equal((await view()).stopPending,true);
    assert.equal((await db.prepare("SELECT recording_consent FROM meeting_members WHERE meeting_id=? AND employee_id=?",[meeting,staffId]).first()).recording_consent,0);
  }finally{globalThis.fetch=fetchLivekit;}
  assert.equal((await view()).recordings[0].status,"Complete");
  const playback=await request("calls/play-recording",200,admin,{id:meeting,recording:recording.id});
  assert.match(new URL(playback.url).searchParams.get("response-content-disposition"),/^inline;/);
  const notifications=await db.prepare("SELECT title FROM notifications WHERE employee_id=? AND href=? AND title IN ('Meeting recording started','Meeting recording stopped')",[staffId,"/staff/calls?meeting="+meeting]).all();
  assert.deepEqual(notifications.results.map(row=>row.title).sort(),["Meeting recording started","Meeting recording stopped"]);

  await request("calls/recording-policy",200,admin,{...configuration,hostApproval:false,participantConsent:false,revision:1});
  await request("calls/record-start",409,admin,{id:meeting});
  await request("calls/consent",200,staff,{id:meeting,consent:"1"});
  await request("calls/record-start",200,admin,{id:meeting});
  await request("calls/record-stop",200,admin,{id:meeting});
  assert.equal((await view()).recordingActive,false);
  await request("calls/record-start",200,admin,{id:meeting});
  await request("calls/recording-policy",200,admin,{...configuration,enabled:false,hostApproval:false,participantConsent:false,revision:2});
  assert.equal((await view()).recordingActive,false);
  assert.equal((await view()).recordingAllowed,false);
  await request("calls/record-start",403,admin,{id:meeting});
  await request("calls/download-recording",200,admin,{id:meeting,recording:recording.id});
  assert.equal((await db.prepare("SELECT count(*)::int AS n FROM meeting_recording_policies WHERE org_id=(SELECT org_id FROM meetings WHERE id=?)",[meeting]).first()).n,3);
  await request("calls/end",200,admin,{id:meeting});
  delete process.env.WALSHKEN_MANAGEMENT_RECORDING_ENABLED;
  console.log("PASS configurable recording roles and categories, independent host actions, consent gates and provider stop retries, immutable policy revisions, private playback and one notification per provider transition");
}
