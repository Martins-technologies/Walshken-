"use client";
import "./meeting-recording-controls.css";
import { useEffect, useState, type FormEvent } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent } from "livekit-client";
import type { RecordingPolicy, RecordingRole } from "@/lib/walshken/meeting-recording-policy";
import { api } from "./ui";

const roleLabels: Record<RecordingRole,string> = {
  super_admin:"Super Admin",admin:"Admin",hr:"HR",manager:"Manager",employee:"Employee",
};
const categories = [["Audio","One-to-one audio"],["Video","One-to-one video"],["Group","Group audio and video"]] as const;

export function RecordingPolicyForm({policy,saved}:{policy:RecordingPolicy;saved:()=>void}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    setBusy(true);setError("");
    try{
      await api("calls/recording-policy",{enabled:form.has("enabled"),hostApproval:form.has("hostApproval"),participantConsent:form.has("participantConsent"),
        requestRoles:form.getAll("requestRoles"),startRoles:form.getAll("startRoles"),categories:form.getAll("categories"),retention:form.get("retention"),revision:policy.revision});
      saved();
    }catch(reason){setError(reason instanceof Error?reason.message:"Recording policy could not be saved.");}
    finally{setBusy(false);}
  }
  return <form className="staff-form recording-policy-form" onSubmit={save}>
    <label><input type="checkbox" name="enabled" defaultChecked={policy.enabled}/> Allow recording in this workspace</label>
    <p>Disabling this setting blocks new recordings and requests that any active recordings stop.</p>
    <div className="staff-fields">
      <fieldset><legend>Roles that may request recording</legend>{(Object.keys(roleLabels) as RecordingRole[]).map(role=><label key={role}><input type="checkbox" name="requestRoles" value={role} defaultChecked={policy.request_roles.includes(role)}/> {roleLabels[role]}</label>)}</fieldset>
      <fieldset><legend>Roles that may start recording</legend>{(Object.keys(roleLabels) as RecordingRole[]).map(role=><label key={role}><input type="checkbox" name="startRoles" value={role} defaultChecked={policy.start_roles.includes(role)}/> {roleLabels[role]}</label>)}</fieldset>
      <fieldset><legend>Meeting categories</legend>{categories.map(([category,label])=><label key={category}><input type="checkbox" name="categories" value={category} defaultChecked={policy.categories.includes(category)}/> {label}</label>)}</fieldset>
      <fieldset><legend>Approval and retention</legend>
        <label><input type="checkbox" name="hostApproval" defaultChecked={policy.host_approval}/> Require a host to approve each recording</label>
        <label><input type="checkbox" name="participantConsent" defaultChecked={policy.participant_consent}/> Require every invitee to consent before recording</label>
        <label>Recording retention for new meetings (days)<input type="number" min={1} max={365} name="retention" required defaultValue={policy.retention_days}/></label>
      </fieldset>
    </div>
    <p>A refusal prevents a new recording and triggers a stop for an active recording. Only eligible roles in the meeting can start recordings.</p>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <button className="btn btn-blue btn-small" type="submit" disabled={busy}>{busy?"Saving…":"Save recording policy"}</button>
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
  return <div aria-live="assertive">{recording&&<strong className="recording-indicator"><i/>This meeting is being recorded</strong>}</div>;
}
