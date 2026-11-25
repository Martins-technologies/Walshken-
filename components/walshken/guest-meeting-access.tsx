"use client";
import "@livekit/components-styles";
import {ConnectionStateToast, ControlBar, GridLayout, LiveKitRoom, ParticipantTile, PreJoin, RoomAudioRenderer, useLocalParticipantPermissions, useTracks} from "@livekit/components-react";
import {Track} from "livekit-client";
import {useCallback, useEffect, useRef, useState} from "react";
import {Icon} from "./brand";
import styles from "./guest-meeting-access.module.css";

type GuestDetails={
  title:string; organizer:string; description:string; instructions:string; startsAt:string; endsAt:string; timeZone:string; mode:string;
  status:string; guestName:string; canJoin:boolean; waiting:boolean; waitingRoom:boolean; recordingEnabled:boolean; recordingRequired:boolean;
  recordingActive:boolean; recordingConsent:number|null; retentionDays:number; roster:{name:string}[];
};
type Access={token:string; serverUrl:string; mode:string; endsAt:string; canPublish:boolean};
type DeviceOptions={audioEnabled:boolean; videoEnabled:boolean; audioDeviceId?:string; videoDeviceId?:string};
type Result=GuestDetails&Partial<Access>&{waiting?:boolean;message?:string;error?:string};
const guestStorageKey="walshken-meeting-guest-id";
const fragment=/^#([0-9a-f-]{36})\.([a-zA-Z0-9_-]{43})$/;

async function callGuest(guest:string,action:string,fields:Record<string,unknown>={}){
  const response=await fetch(`/api/meeting-guest/${action}`,{
    method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({guest,...fields}),cache:"no-store",
  });
  const data=await response.json() as Result;
  if(!response.ok)throw new Error(data.error||"Meeting access is temporarily unavailable.");
  return data;
}
function dateLine(value:string,zone:string){
  return new Intl.DateTimeFormat("en",{weekday:"short",dateStyle:undefined,year:"numeric",month:"short",day:"numeric",hour:"numeric",minute:"2-digit",timeZone:zone,timeZoneName:"short"}).format(new Date(value));
}
function GuestConference({mode,onError}:{mode:string;onError:(message:string)=>void}){
  const tracks=useTracks([{source:Track.Source.Camera,withPlaceholder:true},{source:Track.Source.ScreenShare,withPlaceholder:false}]);
  const permission=useLocalParticipantPermissions();
  const publish=permission?.canPublish===true;
  const share=permission?.canPublishSources?.some(source=>Number(source)===3)===true;
  return <>
    <GridLayout tracks={tracks} className={styles.grid}><ParticipantTile/></GridLayout>
    <RoomAudioRenderer/>
    <ControlBar controls={{microphone:publish,camera:publish&&mode==="Video",screenShare:share,chat:false,settings:false,leave:true}}
      onDeviceError={({error})=>onError(error.message)} saveUserChoices={false}/>
    <ConnectionStateToast/>
  </>;
}

export function GuestMeetingAccess(){
  const [guest,setGuest]=useState("");
  const [meeting,setMeeting]=useState<GuestDetails|null>(null);
  const [error,setError]=useState("");
  const [name,setName]=useState("");
  const [busy,setBusy]=useState(false);
  const [prejoin,setPrejoin]=useState(false);
  const [access,setAccess]=useState<Access|null>(null);
  const [devices,setDevices]=useState<DeviceOptions|null>(null);
  const [waiting,setWaiting]=useState(false);
  const [initializing,setInitializing]=useState(true);
  const readLink=useRef(false);
  useEffect(()=>{
    if(readLink.current)return;
    readLink.current=true;
    const params=window.location.hash.match(fragment);
    const oldGuest=()=>{try{return sessionStorage.getItem(guestStorageKey)||"";}catch{return "";}};
    const target=params?.[1]||oldGuest();
    if(params)window.history.replaceState(null,"",window.location.pathname+window.location.search);
    if(!target){setInitializing(false);setError("Open the secure meeting link from your Walshken invitation.");return;}
    setGuest(target);
    void callGuest(target,params?"exchange":"status",params?{token:params[2]}:{})
      .then(data=>{
        setMeeting(data);setName(data.guestName);setWaiting(data.waiting);
        try{sessionStorage.setItem(guestStorageKey,target);}catch{/* This session remains available on the current page. */}
      }).catch(e=>setError(e instanceof Error?e.message:"Could not open this invitation.")).finally(()=>setInitializing(false));
  },[]);
  useEffect(()=>{
    if(!guest||!meeting)return;
    const timer=window.setInterval(()=>{
      void callGuest(guest,"status").then(data=>{
        setMeeting(data);
        if(data.status!=="Accepted"||Date.now()>=Date.parse(data.endsAt)){setAccess(null);setWaiting(false);}
        else if(waiting&&!data.waiting&&data.canJoin){
          void callGuest(guest,"join").then(response=>{
            if(response.token&&response.serverUrl){setWaiting(false);setAccess(response as Access);}
          }).catch(e=>{setWaiting(false);setError(String(e.message));});
        }
      }).catch(e=>{
        setAccess(null);setWaiting(false);setError(e instanceof Error?e.message:"Meeting access is no longer available.");
      });
    },waiting?3000:5000);
    return()=>window.clearInterval(timer);
  },[guest,!!meeting,waiting]);
  const act=useCallback(async(action:string,fields:Record<string,unknown>={})=>{
    if(!guest||busy)return;
    setBusy(true);setError("");
    try{
      const result=await callGuest(guest,action,fields);
      if(result.title)setMeeting(result);
      if(result.token&&result.serverUrl){setAccess(result as Access);setWaiting(false);setPrejoin(false);}
      else if(action==="join"&&result.waiting){setWaiting(true);setPrejoin(false);}
      else if(action==="leave"){setAccess(null);setWaiting(false);}
    }catch(e){setError(e instanceof Error?e.message:"Could not complete this action.");}
    finally{setBusy(false);}
  },[busy,guest]);
  return <main className={styles.page}>
    <article className={`${styles.card} ${access?styles.roomCard:""}`}>
      <div className={styles.brand}><Icon name="video" size={21}/> Walshken <span>Meeting access</span></div>
      {initializing&&<p role="status">Opening your invitation…</p>}
      {error&&<div className={styles.error} role="alert">{error}</div>}
      {meeting&&<>
        <header className={styles.heading}>
          <p>{meeting.mode} meeting · {meeting.status}</p><h1>{meeting.title}</h1>
          <p>Organized by {meeting.organizer}</p>
        </header>
        <dl className={styles.details}>
          <div><dt>Starts</dt><dd>{dateLine(meeting.startsAt,meeting.timeZone)}</dd></div>
          <div><dt>Ends</dt><dd>{dateLine(meeting.endsAt,meeting.timeZone)}</dd></div>
        </dl>
        {meeting.description&&<p className={styles.copy}>{meeting.description}</p>}
        {meeting.instructions&&<section className={styles.instructions}><h2>Meeting instructions</h2><p>{meeting.instructions}</p></section>}
        {meeting.recordingActive&&<div className={styles.recording} role="status"><i/> This meeting is being recorded</div>}
        {meeting.status==="Invited"&&<form className={styles.form} onSubmit={event=>{event.preventDefault();void act("accept",{name});}}>
          <label>Your display name<input value={name} onChange={event=>setName(event.target.value)} required maxLength={100} autoComplete="name"/></label>
          <div className={styles.actions}><button className={styles.primary} disabled={busy} type="submit">Accept invitation</button><button type="button" disabled={busy} onClick={()=>void act("decline")}>Decline</button></div>
        </form>}
        {meeting.status==="Accepted"&&<>
          {(meeting.recordingEnabled||meeting.recordingActive)&&<section className={styles.instructions}><h2>Recording consent</h2>
            <p>Your voice, video, and shared screen can be recorded. Recordings are private and retained for {meeting.retentionDays} days.{meeting.recordingRequired?" The meeting requires consent before recording.":""}</p>
            <div className={styles.actions}><button type="button" disabled={busy||!meeting.recordingEnabled||meeting.recordingConsent===1} onClick={()=>void act("consent",{consent:"1"})}>{meeting.recordingConsent===1?"Consent saved":"Give consent"}</button>
              <button type="button" disabled={busy||meeting.recordingConsent===0} onClick={()=>void act("consent",{consent:"0"})}>{meeting.recordingConsent===0?"Recording declined":meeting.recordingConsent===1?"Withdraw consent":"Decline recording"}</button></div>
          </section>}
          {!access&&waiting&&<p className={styles.instructions} role="status">Waiting for the host to admit you. Leave this tab open.</p>}
          {!access&&!waiting&&(meeting.canJoin?(prejoin?
            <div className={styles.prejoin} data-lk-theme="default"><PreJoin defaults={{username:meeting.guestName,audioEnabled:true,videoEnabled:meeting.mode==="Video"}}
              persistUserChoices={false} joinLabel="Join meeting" onValidate={()=>!busy} onError={e=>setError(e.message)}
              onSubmit={selection=>{setDevices(selection);void act("join");}}/></div>
            :<div className={styles.actions}><button type="button" className={styles.primary} onClick={()=>setPrejoin(true)} disabled={busy}>Check devices and {meeting.waitingRoom?"request entry":"join"}</button>
              <button type="button" onClick={()=>void act("decline")} disabled={busy}>Decline invitation</button></div>)
            :<p role="status">Joining opens 15 minutes before the scheduled start, if the meeting is unlocked.</p>)}
          {access&&<div data-lk-theme="default" className={styles.room}><LiveKitRoom serverUrl={access.serverUrl} token={access.token}
            audio={access.canPublish&&devices?.audioEnabled?{deviceId:devices.audioDeviceId}:false}
            video={access.canPublish&&access.mode==="Video"&&devices?.videoEnabled?{deviceId:devices.videoDeviceId}:false}
            options={{adaptiveStream:true,dynacast:true}} onError={e=>setError(e.message)} onDisconnected={()=>{setAccess(null);void act("leave");}}>
            <GuestConference mode={access.mode} onError={setError}/>
          </LiveKitRoom></div>}
          {!!meeting.roster.length&&<details><summary>Meeting participants</summary><ul>{meeting.roster.map(({name:item},index)=><li key={index}>{item}</li>)}</ul></details>}
        </>}
        {meeting.status==="Declined"&&<p role="status">The organizer has been notified that you declined.</p>}
        {(meeting.status==="Cancelled"||meeting.status==="Ended")&&<p role="status">You can no longer join this meeting.</p>}
      </>}
    </article>
  </main>;
}
