"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ConnectionStateToast, GridLayout, LiveKitRoom, ParticipantTile, RoomAudioRenderer, StartAudio, useLocalParticipant, useRoomContext, useTracks } from "@livekit/components-react";
import { Track } from "livekit-client";
import "@livekit/components-styles";
import { Icon } from "./brand";
import styles from "./client-calls.module.css";

type Audience = "client" | "staff";
type Mode = "Audio" | "Video";
type Status = "Ringing" | "Accepted" | "Connected" | "Busy" | "Unavailable" | "Missed" | "Declined" | "Ended" | "Cancelled";
type Call = {id:string;contact:string;caseId:string|null;reference:string|null;mode:Mode;status:Status;direction:"incoming"|"outgoing";createdAt:string;ringUntil:string;connectedAt:string|null;endedAt:string|null;canJoin:boolean};
type Destination = {id:string;caseId:string|null;name:string;detail:string;kind:string;available:boolean};
type Activity = {calls:Call[];destinations:Destination[];configured:boolean};
type MediaAccess = {id:string;token:string;serverUrl:string;mode:Mode};
const active = (call: Call) => call.status === "Ringing" || call.canJoin;
const messages: Record<string,string> = {
  Busy:"The contact is busy. Try again in a moment.", Unavailable:"The contact is unavailable. Try again later.",
  Missed:"The call was not answered.", Declined:"The recipient declined the call.", Cancelled:"The call was cancelled.",
};

class CallError extends Error {
  constructor(message:string, readonly status:number) { super(message); }
}

async function callApi<T>(audience: Audience, action: string, data?: Record<string,unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/client-calls/${audience}/${action}`,data ? {
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(data),signal,
  } : {cache:"no-store",signal});
  const body = await response.json().catch(()=>null);
  if (!response.ok) throw new CallError(body?.error || "Client calling is unavailable. Try again.",response.status);
  return body as T;
}

const errorText = (failure:unknown) => failure instanceof Error ? failure.message : "The call could not be completed.";
const dateLabel = (value:string) => new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(new Date(value));

function duration(call: Call) {
  if (!call.connectedAt || !call.endedAt) return "";
  const elapsed=Math.max(0,Math.floor((Date.parse(call.endedAt)-Date.parse(call.connectedAt))/1000));
  return elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed/60)}m ${elapsed%60}s`;
}

function CallMedia({mode,contact,onEnd,onFailure}:{mode:Mode;contact:string;onEnd:()=>void;onFailure:(message:string)=>void}) {
  const room=useRoomContext();
  const {localParticipant,isMicrophoneEnabled,isCameraEnabled}=useLocalParticipant();
  const cameras=useTracks([{source:Track.Source.Camera,withPlaceholder:true}]);
  const [devices,setDevices]=useState<MediaDeviceInfo[]>([]);
  const [audioDevice,setAudioDevice]=useState("");

  useEffect(()=>{
    if(mode!=="Video"||typeof HTMLMediaElement==="undefined"||!("setSinkId" in HTMLMediaElement.prototype)||!navigator.mediaDevices?.enumerateDevices)return;
    let mounted=true;
    const update=()=>void navigator.mediaDevices.enumerateDevices().then(list=>{
      if(mounted)setDevices(list.filter(device=>device.kind==="audiooutput"&&device.deviceId));
    },()=>{});
    update();navigator.mediaDevices.addEventListener("devicechange",update);
    return()=>{mounted=false;navigator.mediaDevices.removeEventListener("devicechange",update);};
  },[mode]);

  async function toggle(kind:"microphone"|"camera") {
    try {
      if(kind==="microphone")await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
      else await localParticipant.setCameraEnabled(!isCameraEnabled);
    }catch{onFailure(`Could not change the ${kind}. Check your browser and device permissions.`);}
  }

  async function changeOutput(value:string) {
    try{await room.switchActiveDevice("audiooutput",value);setAudioDevice(value);}
    catch{onFailure("This browser or device could not change the audio output.");}
  }

  return <>
    <RoomAudioRenderer/><ConnectionStateToast/><StartAudio label="Enable call audio"/>
    {mode==="Video" ? <div className={styles.video}>
      <GridLayout tracks={cameras}><ParticipantTile/></GridLayout>
    </div> : <div className={styles.audioStage}><span aria-hidden="true"><Icon name="phone" size={29}/></span><strong>{contact}</strong></div>}
    <div className={styles.mediaControls} aria-label="Call controls">
      <button type="button" className="btn btn-outline btn-small" aria-pressed={isMicrophoneEnabled} onClick={()=>void toggle("microphone")}>
        <Icon name="mic" size={16}/>{isMicrophoneEnabled?"Mute microphone":"Unmute microphone"}
      </button>
      {mode==="Video"&&<button type="button" className="btn btn-outline btn-small" aria-pressed={isCameraEnabled} onClick={()=>void toggle("camera")}>
        <Icon name="video" size={16}/>{isCameraEnabled?"Turn camera off":"Turn camera on"}
      </button>}
      {devices.length>0&&mode==="Video"&&<label className={styles.audioOutput}>Audio output
        <select value={audioDevice} onChange={event=>void changeOutput(event.target.value)}>
          <option value="">System default</option>
          {devices.map((device,index)=><option key={device.deviceId} value={device.deviceId}>{device.label||`Output ${index+1}`}</option>)}
        </select>
      </label>}
      <button type="button" className="btn btn-danger btn-small" onClick={onEnd}><Icon name="close" size={16}/>End call</button>
    </div>
  </>;
}

export function ClientCalls({audience,caseId,compact=false}:{audience:Audience;caseId?:string;compact?:boolean}) {
  const [data,setData]=useState<Activity|null>(null);
  const [notice,setNotice]=useState("");
  const [error,setError]=useState("");
  const [activityError,setActivityError]=useState("");
  const [action,setAction]=useState("");
  const [media,setMedia]=useState<MediaAccess|null>(null);
  const [ringingEnabled,setRingingEnabled]=useState(false);
  const locked=useRef(false);
  const requestSequence=useRef(0);
  const audio=useRef<AudioContext|null>(null);
  const selected=data?.calls.find(active);
  const incoming=selected?.status==="Ringing"&&selected.direction==="incoming";
  const activityPath=caseId?`activity?case=${encodeURIComponent(caseId)}`:"activity";
  const haltMedia=useRef(false);
  const mediaId=useRef<string|null>(null);

  const clearMedia=useCallback(()=>{
    haltMedia.current=true;mediaId.current=null;setMedia(null);
  },[]);

  const refresh=useCallback(async(signal?:AbortSignal)=>{
    const sequence=++requestSequence.current;
    try {
      const result=await callApi<Activity>(audience,activityPath,undefined,signal);
      if(signal?.aborted||sequence!==requestSequence.current)return;
      setData(result);
      setActivityError("");
      if(mediaId.current&&!result.calls.some(call=>call.id===mediaId.current&&call.canJoin))clearMedia();
    } catch(failure) {
      if(signal?.aborted||sequence!==requestSequence.current)return;
      if(failure instanceof CallError&&[401,403].includes(failure.status)){clearMedia();setData(null);}
      setActivityError(errorText(failure));
    }
  },[audience,activityPath,clearMedia]);

  useEffect(()=>{
    let busy=false;
    const controller=new AbortController();
    const pulse=async()=>{
      if(busy||controller.signal.aborted||document.visibilityState!=="visible")return;
      busy=true;try{await refresh(controller.signal);}finally{busy=false;}
    };
    void pulse();
    const timer=window.setInterval(()=>void pulse(),4_000);
    const resume=()=>void pulse();
    document.addEventListener("visibilitychange",resume);
    return()=>{controller.abort();window.clearInterval(timer);document.removeEventListener("visibilitychange",resume);};
  },[refresh]);

  useEffect(()=>{
    if(!incoming||!ringingEnabled)return;
    const ring=()=>{
      const system=audio.current;
      if(!system||system.state!=="running"||document.visibilityState!=="visible")return;
      const tone=system.createOscillator(), volume=system.createGain();
      const start=system.currentTime;
      tone.frequency.value=570;volume.gain.setValueAtTime(.06,start);volume.gain.exponentialRampToValueAtTime(.001,start+.45);
      tone.connect(volume);volume.connect(system.destination);tone.start(start);tone.stop(start+.5);
      tone.onended=()=>{tone.disconnect();volume.disconnect();};
    };
    ring();const timer=window.setInterval(ring,2500);
    return()=>window.clearInterval(timer);
  },[incoming,ringingEnabled]);

  useEffect(()=>()=>{if(audio.current)void audio.current.close();},[]);

  async function toggleRinging() {
    if(ringingEnabled){setRingingEnabled(false);return;}
    try {audio.current??=new AudioContext();await audio.current.resume();setRingingEnabled(audio.current.state==="running");}
    catch {setError("This browser cannot play a ringing sound. Incoming calls will still appear here.");}
  }

  async function execute(label:string,work:()=>Promise<void>) {
    if(locked.current)return;
    locked.current=true;setAction(label);setError("");setNotice("");
    try {await work();} catch(failure) {setError(errorText(failure));}
    finally {await refresh();locked.current=false;setAction("");}
  }

  function start(contact: Destination,mode: Mode) {
    void execute("Starting call",async()=>{
      const {call}=await callApi<{call:Call}>(audience,"start",{case:contact.caseId??"",target:audience==="client"?contact.id:"",mode});
      if(call.status!=="Ringing")setNotice(messages[call.status]??"Unable to reach this contact.");
    });
  }

  async function join(id:string) {
    const result=await callApi<MediaAccess>(audience,"token",{id});
    haltMedia.current=false;mediaId.current=result.id;setMedia(result);
  }

  function respond(type:"accept"|"decline"|"end",call: Call) {
    void execute(type==="accept"?"Accepting call":type==="end"?"Ending call":"Declining call",async()=>{
      const result=await callApi<{call:Call}>(audience,type,{id:call.id});
      if(type==="accept"&&result.call.canJoin){await join(call.id);return;}
      if(type==="end")clearMedia();
      if(messages[result.call.status])setNotice(messages[result.call.status]);
    });
  }

  if(compact&&!selected)return null;
  return <section className={styles.calls} aria-label="Client and company calls" aria-busy={!!action}>
    {!compact&&<header className={styles.header}><div><h2>{audience==="client"?"Call Walshken":"Client calls"}</h2>
      <p>{audience==="client"?"Use audio or video to speak with an approved Walshken contact.":"Make and receive calls for cases and company routes assigned to you."}</p></div>
      {data?.configured&&<button type="button" className="btn btn-outline btn-small" aria-pressed={ringingEnabled} onClick={()=>void toggleRinging()}>
        <Icon name="bell" size={16}/>{ringingEnabled?"Mute ringing":"Enable ringing sound"}
      </button>}
    </header>}
    {(error||activityError)&&<div className={styles.error} role="alert"><span>{error||activityError}</span><button className="btn btn-outline btn-small" type="button" onClick={()=>{setError("");void refresh();}}>Refresh</button></div>}
    {notice&&<p className={styles.notice} role="status">{notice}</p>}
    {action&&<p className="sr-only" role="status">{action}…</p>}
    {!data&&!error&&!activityError&&<p className={styles.empty} role="status">Loading calling access…</p>}
    {data&&!data.configured&&!selected&&<p className={styles.notice}>{audience==="client"?"Walshken calling is temporarily unavailable.":"Calling is temporarily unavailable. Ask a Super Admin to verify the LiveKit connection."}</p>}
    {selected&&<div className={styles.activeCall} aria-label={`${selected.direction} ${selected.mode.toLowerCase()} call`}>
      <div className={styles.activeHeader}>
        <span className={styles.callIcon} aria-hidden="true"><Icon name={selected.mode==="Video"?"video":"phone"} size={24}/></span>
        <div><strong>{selected.contact}</strong><p role="status">{incoming?`Incoming ${selected.mode.toLowerCase()} call`:selected.status==="Ringing"?"Calling…":selected.status==="Accepted"?"Call accepted. Connecting…":"Call connected"}</p></div>
        {selected.status==="Ringing"&&(incoming?<div className={styles.actions}>
          <button type="button" className="btn btn-blue btn-small" disabled={!!action} onClick={()=>respond("accept",selected)}>Accept</button>
          <button type="button" className="btn btn-outline btn-small" disabled={!!action} onClick={()=>respond("decline",selected)}>Decline</button>
        </div>:<button type="button" className="btn btn-outline btn-small" disabled={!!action} onClick={()=>respond("end",selected)}>Cancel call</button>)}
        {selected.canJoin&&!media&&<div className={styles.actions}>
          <button type="button" className="btn btn-blue btn-small" disabled={!!action} onClick={()=>void execute("Joining call",()=>join(selected.id))}>Join call</button>
          <button type="button" className="btn btn-outline btn-small" disabled={!!action} onClick={()=>respond("end",selected)}>End call</button>
        </div>}
      </div>
      {media?.id===selected.id&&selected.canJoin&&<div className={styles.live} data-lk-theme="default">
        <LiveKitRoom serverUrl={media.serverUrl} token={media.token} audio={false} video={false} options={{adaptiveStream:true,dynacast:true}}
          onDisconnected={()=>{mediaId.current=null;setMedia(null);if(!haltMedia.current)setNotice("The connection closed. Rejoin while the call is active.");void refresh();}}
          onError={()=>{clearMedia();setError("The media connection failed. Try joining again.");}}
          onMediaDeviceFailure={()=>setError("Camera or microphone access failed. Check your browser and device permissions.")}>
          <CallMedia mode={media.mode} contact={selected.contact} onEnd={()=>respond("end",selected)} onFailure={setError}/>
        </LiveKitRoom>
      </div>}
    </div>}
    {!compact&&data&&<>
      <div className={styles.sectionHeading}><h3>{audience==="client"?"Approved contacts":"Assigned clients"}</h3></div>
      {data.destinations.length ? <ul className={styles.contactList}>{data.destinations.map(contact=><li key={`${contact.caseId??"company"}:${contact.id}`}>
        <div><span className={styles.contactKind}>{contact.kind}</span><strong>{contact.name}</strong>{contact.detail&&<small>{contact.detail}</small>}</div>
        <div className={styles.actions}>
          {contact.available&&data.configured?<><button type="button" className="btn btn-outline btn-small" disabled={!!action||!!selected} onClick={()=>start(contact,"Audio")} aria-label={`Audio call ${contact.name}`}><Icon name="phone" size={16}/>Audio</button>
            <button type="button" className="btn btn-outline btn-small" disabled={!!action||!!selected} onClick={()=>start(contact,"Video")} aria-label={`Video call ${contact.name}`}><Icon name="video" size={16}/>Video</button></>:<span className={styles.status}>Unavailable</span>}
        </div>
      </li>)}</ul>:<p className={styles.empty}>{audience==="client"?"No approved contacts are available yet.":"No assigned cases have client calling enabled."}</p>}
      <div className={styles.sectionHeading}><h3>Recent calls</h3></div>
      {data.calls.length ? <ol className={styles.history}>{data.calls.map(call=><li key={call.id}>
        <span className={styles.historyIcon} aria-hidden="true"><Icon name={call.mode==="Video"?"video":"phone"} size={17}/></span>
        <div><strong>{call.contact}</strong><small>{call.direction==="incoming"?"Incoming":"Outgoing"} {call.mode.toLowerCase()}{call.reference?` · ${call.reference}`:""}</small></div>
        <time dateTime={call.createdAt}>{dateLabel(call.createdAt)}</time>
        <span className={styles.status} data-status={call.status}>{call.status}{duration(call)?` · ${duration(call)}`:""}</span>
      </li>)}</ol>:<p className={styles.empty}>Your recent calls will appear here.</p>}
    </>}
  </section>;
}

type RouteEntry = {id:string;name:string;kind:"Office"|"Support";employee_id:string;employee_name:string;enabled:boolean;revision:number};
type Configuration = {endpoints:RouteEntry[];staff:{id:string;name:string}[];configured:boolean};

export function ClientCallSettings() {
  const [configuration,setConfiguration]=useState<Configuration|null>(null);
  const [editing,setEditing]=useState<string|null>(null);
  const [error,setError]=useState("");
  const [status,setStatus]=useState("");
  const [saving,setSaving]=useState(false);
  const current=configuration?.endpoints.find(route=>route.id===editing);
  const load=useCallback(async(signal?:AbortSignal)=>{
    try{const settings=await callApi<Configuration>("staff","configuration",undefined,signal);if(!signal?.aborted){setConfiguration(settings);setError("");}}
    catch(failure){if(!signal?.aborted)setError(errorText(failure));}
  },[]);
  useEffect(()=>{const controller=new AbortController();void load(controller.signal);return()=>controller.abort();},[load]);

  async function save(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    setSaving(true);setError("");setStatus("");
    try{
      await callApi("staff","configure",{id:current?.id??"",revision:current?.revision??0,name:form.get("name"),kind:form.get("kind"),
        employee:form.get("employee"),enabled:form.get("enabled")==="on"});
      setEditing(null);setStatus("Company call route saved.");await load();
    }catch(failure){setError(errorText(failure));}finally{setSaving(false);}
  }

  return <section className={styles.calls} aria-label="Company call routing">
    <header className={styles.header}><div><h2>Company call routing</h2><p>Choose which office and Support contacts clients see and who answers for each one.</p></div>
      {configuration&&<button type="button" className="btn btn-blue btn-small" onClick={()=>{setError("");setEditing("");}}>Add call route</button>}
    </header>
    {error&&<p className={styles.error} role="alert">{error}</p>}
    {status&&<p className={styles.notice} role="status">{status}</p>}
    {configuration&&!configuration.configured&&<p className={styles.notice}>Connect and test LiveKit in <a href="/staff/integrations">Integrations</a> to receive calls.</p>}
    {!configuration&&!error&&<p className={styles.empty} role="status">Loading company routes…</p>}
    {editing!==null&&configuration&&<form method="post" key={editing} className={styles.settings} onSubmit={event=>void save(event)}>
      <label>Company display name<input name="name" minLength={2} maxLength={100} required defaultValue={current?.name}/></label>
      <label>Route type<select name="kind" defaultValue={current?.kind??"Office"}><option>Office</option><option>Support</option></select></label>
      <label>Assigned receiver<select name="employee" required defaultValue={current?.employee_id??""}><option value="">Choose an employee</option>
        {current&&!configuration.staff.some(person=>person.id===current.employee_id)&&<option value={current.employee_id}>{current.employee_name} (inactive)</option>}
        {configuration.staff.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}
      </select></label>
      <label className={styles.checkbox}><input type="checkbox" name="enabled" defaultChecked={current?.enabled??true}/>Available to clients</label>
      <div className={styles.actions}><button type="button" className="btn btn-outline btn-small" disabled={saving} onClick={()=>setEditing(null)}>Cancel</button>
        <button className="btn btn-blue btn-small" disabled={saving}>{saving?"Saving…":"Save route"}</button></div>
    </form>}
    {configuration&&(configuration.endpoints.length ? <ul className={styles.contactList}>{configuration.endpoints.map(route=><li key={route.id}>
      <div><span className={styles.contactKind}>{route.kind}</span><strong>{route.name}</strong><small>Answers to {route.employee_name}</small></div>
      <span className={styles.status}>{route.enabled?"Enabled":"Disabled"}</span>
      <button type="button" className="btn btn-outline btn-small" onClick={()=>{setError("");setEditing(route.id);}}>Edit route</button>
    </li>)}</ul>:editing===null&&<p className={styles.empty}>No company call routes have been configured.</p>)}
  </section>;
}
