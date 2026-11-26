"use client";
import "./meeting-recording-controls.css";
import { useEffect, useState, type FormEvent } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent } from "livekit-client";
import type { RecordingPolicy, RecordingRole } from "@/lib/walshken/meeting-recording-policy";
import { Icon } from "./brand";
import { api } from "./ui";

const roleLabels: Record<RecordingRole,string> = {
  super_admin:"Super Admin",admin:"Admin",hr:"HR",manager:"Manager",employee:"Employee",
};
const categories = [["Audio","One-to-one audio"],["Video","One-to-one video"],["Group","Group audio and video"]] as const;

export function RecordingPolicyForm({policy,saved}:{policy:RecordingPolicy;saved:()=>void}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const [draft,setDraft]=useState(policy);
  const stale=policy.revision!==draft.revision;
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(stale||busy)return;
    const form=new FormData(event.currentTarget);
    setBusy(true);setError("");
    try{
      await api("calls/recording-policy",{enabled:form.has("enabled"),hostApproval:form.has("hostApproval"),participantConsent:form.has("participantConsent"),
        requestRoles:form.getAll("requestRoles"),startRoles:form.getAll("startRoles"),categories:form.getAll("categories"),retention:form.get("retention"),revision:draft.revision});
      saved();
    }catch(reason){setError(reason instanceof Error?reason.message:"Recording policy could not be saved.");}
    finally{setBusy(false);}
  }
  return <form key={draft.revision} className="staff-form recording-policy-form" onSubmit={save}>
    <div className="recording-policy-main"><Icon name="video" size={21}/><div>
      <label><input type="checkbox" name="enabled" defaultChecked={draft.enabled}/> Allow recording in this workspace</label>
      <p>Disabling recording blocks new recordings and stops active ones.</p>
    </div></div>
    {stale&&<p className="form-error" role="status">Another administrator saved changes. <button type="button" className="text-link" onClick={()=>{setDraft(policy);setError("");}}>Load latest policy</button></p>}
    <div className="staff-fields">
      <fieldset><legend>Roles that may request recording</legend>{(Object.keys(roleLabels) as RecordingRole[]).map(role=><label key={role}><input type="checkbox" name="requestRoles" value={role} defaultChecked={draft.request_roles.includes(role)}/> {roleLabels[role]}</label>)}</fieldset>
      <fieldset><legend>Roles that may start recording</legend>{(Object.keys(roleLabels) as RecordingRole[]).map(role=><label key={role}><input type="checkbox" name="startRoles" value={role} defaultChecked={draft.start_roles.includes(role)}/> {roleLabels[role]}</label>)}</fieldset>
      <fieldset><legend>Meeting categories</legend>{categories.map(([category,label])=><label key={category}><input type="checkbox" name="categories" value={category} defaultChecked={draft.categories.includes(category)}/> {label}</label>)}</fieldset>
      <fieldset><legend>Approval and retention</legend>
        <label><input type="checkbox" name="hostApproval" defaultChecked={draft.host_approval}/> Require a host to approve each recording</label>
        <label><input type="checkbox" name="participantConsent" defaultChecked={draft.participant_consent}/> Require every invitee to consent before recording</label>
        <label>Retention for new meetings (days)<input type="number" min={1} max={365} name="retention" required defaultValue={draft.retention_days}/></label>
      </fieldset>
    </div>
    <p>A refusal prevents a new recording and triggers a stop for an active recording. Only eligible roles in the meeting can start recordings.</p>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <button className="btn btn-blue" type="submit" disabled={busy||stale}>{busy?"Saving…":"Save recording policy"}</button>
  </form>;
}

export function RecordingLiveIndicator(){
  const room=useRoomContext();
  const [recording,setRecording]=useState(room.isRecording);
  useEffect(()=>{
    setRecording(room.isRecording);
    room.on(RoomEvent.RecordingStatusChanged,setRecording);
    return()=>{room.off(RoomEvent.RecordingStatusChanged,setRecording);};
  },[room]);
  return <div className="call-live-recording-banner" aria-live="assertive">{recording&&<strong className="recording-indicator"><i/>This meeting is being recorded</strong>}</div>;
}
