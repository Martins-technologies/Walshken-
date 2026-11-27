"use client";
import "@livekit/components-styles";
import "./calls-workspace.css";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { LiveKitRoom, PreJoin, GridLayout, ParticipantTile, FocusLayout, RoomAudioRenderer, ControlBar, ConnectionStateToast, StartAudio, useLocalParticipantPermissions, useTracks, useRoomContext } from "@livekit/components-react";
import { Track } from "livekit-client";
import { TrackSource } from "@livekit/protocol";
import { meetingLocalStamp } from "@/lib/walshken/meeting-time";
import { Icon } from "./brand";
import { ActionForm, api, dateText, Empty, FieldInput, initials, options, Status, Table, value, type Field, type RecordRow, type ResponseData } from "./ui";
import type { ViewData } from "./workspace-views";
import type { Viewer } from "./workspace";
import { RecordingLiveIndicator, RecordingPolicyForm } from "./meeting-recording-controls";
import type { RecordingCategory } from "@/lib/walshken/meeting-recording-policy";

type Details={meeting:RecordRow;members:RecordRow[];externalGuests?:RecordRow[];recordings:RecordRow[];attendance:RecordRow[];host:boolean;canRecord:boolean;recordingActive:boolean;consentText:string;
  recordingStatus:string|null;recordingBlocker:string|null;stopPending:boolean;recordingAllowed:boolean;consentRequired:boolean;canStopRecording:boolean;canRequestRecording:boolean;canDecideRecording:boolean;recordingRequest:{id:string;status:string}|null};
type Access={token:string;serverUrl:string;mode:string;endsAt:string;canPublish:boolean};
type Devices={audioEnabled:boolean;videoEnabled:boolean;audioDeviceId?:string;videoDeviceId?:string;username:string};
const elapsed=(seconds:number)=>{const minutes=Math.floor(Math.max(0,seconds)/60);return `${Math.floor(minutes/60)}h ${minutes%60}m ${Math.floor(Math.max(0,seconds)%60)}s`;};
const admin=(actor:Viewer)=>actor.role==="super_admin"||actor.role==="admin";
const date=(actor:Viewer,raw:unknown)=>dateText(raw as string,true,actor.timeZone);
function Modal({title,close,children}:{title:string;close:()=>void;children:ReactNode}){
  const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{const node=ref.current;node?.showModal();return()=>node?.close();},[]);
  return <dialog ref={ref} className="chat-dialog call-dialog" aria-label={title} onCancel={close} onClick={e=>{if(e.target===e.currentTarget)close();}}><div className="call-dialog-content"><div className="chat-dialog-heading"><h2>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={close}><Icon name="close"/></button></div>{children}</div></dialog>;
}
function ConferenceStage({mode,endsAt,onError}:{mode:string;endsAt:string;onError:(message:string)=>void}){
  const room=useRoomContext(),permission=useLocalParticipantPermissions();
  const tracks=useTracks([{source:Track.Source.Camera,withPlaceholder:true},{source:Track.Source.ScreenShare,withPlaceholder:false}],{onlySubscribed:false});
  const screen=tracks.find(track=>track.source===Track.Source.ScreenShare&&track.publication?.isSubscribed);
  useEffect(()=>{const timer=setTimeout(()=>{void room.disconnect();},Math.max(0,Date.parse(endsAt)-Date.now()));return()=>clearTimeout(timer);},[endsAt,room]);
  const sources=permission?.canPublishSources??[],publish=!!permission?.canPublish;
  return <><RecordingLiveIndicator/><div className={`call-stage ${screen?"has-presentation":""}`}>
    {screen&&<FocusLayout trackRef={screen} className="call-presentation"/>}
    <GridLayout tracks={tracks.filter(track=>!screen||track!==screen)}><ParticipantTile/></GridLayout>
  </div><RoomAudioRenderer/><StartAudio label="Enable meeting audio"/>
    <ControlBar variation="verbose" saveUserChoices={false} controls={{microphone:publish,camera:mode==="Video"&&publish,screenShare:publish&&sources.includes(TrackSource.SCREEN_SHARE),chat:false,settings:false,leave:true}} onDeviceError={({error})=>onError(error.message)}/><ConnectionStateToast/></>;
}

function MeetingComposer({action,fields,people,finished,onTypeChange}:{
  action:string;fields:Field[];people:RecordRow[];finished:(result:ResponseData)=>void;onTypeChange:(name:string,value:string)=>void;
}){
  const [query,setQuery]=useState(""),[picked,setPicked]=useState<string[]>([]),[single,setSingle]=useState(false);
  const [pending,setPending]=useState(false),[failure,setFailure]=useState("");
  const matches=people.filter(person=>picked.includes(value(person,"id"))||value(person,"name").toLowerCase().includes(query.trim().toLowerCase()));
  const ordinary=fields.filter(field=>!['waiting','screenSharing','recording'].includes(field.name));
  const settings=fields.filter(field=>['waiting','screenSharing','recording'].includes(field.name));
  async function send(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(pending)return;
    const payload=Object.fromEntries(new FormData(event.currentTarget)) as Record<string,unknown>;
    payload.members=picked;
    for(const field of ordinary){
      if(field.type==="datetime-local"&&!field.preserveLocalValue&&payload[field.name])payload[field.name]=new Date(String(payload[field.name])).toISOString();
    }
    setPending(true);setFailure("");
    try{finished(await api(`calls/${action}`,payload));}
    catch(reason){setFailure(reason instanceof Error?reason.message:"Unable to save this meeting.");}
    finally{setPending(false);}
  }
  return <form method="post" className="staff-form call-composer" onSubmit={send} onInvalidCapture={event=>{
    const target=event.target;
    if(target instanceof HTMLElement){const settings=target.closest("details");if(settings)settings.open=true;}
  }} onChangeCapture={event=>{
    const input=event.target;
    if(!(input instanceof HTMLSelectElement)||(input.name!=="type"&&input.name!=="mode"))return;
    onTypeChange(input.name,input.value);
    if(input.name==="type"){
      const one=input.value==="One-to-one";
      setSingle(one);
      if(one)setPicked(current=>current.slice(0,1));
    }
  }}>
    <div className="staff-fields call-composer-fields">{ordinary.slice(0,3).map(field=><FieldInput key={field.name} field={field}/>)}</div>
    <fieldset className="call-invite-picker">
      <legend>Staff participants <span>{picked.length} selected</span></legend>
      {people.length>0?<>
        <label className="chat-find"><Icon name="search" size={16}/><span className="sr-only">Find team members</span><input type="search" placeholder="Find team members" value={query} onChange={event=>setQuery(event.target.value)} maxLength={100}/></label>
        <div className="call-invite-options">{matches.map(person=>{
          const id=value(person,"id"),name=value(person,"name");
          return <label key={id}><input type="checkbox" checked={picked.includes(id)} onChange={event=>{
            const checked=event.target.checked;
            setPicked(current=>checked?single?[id]:[...current,id]:current.filter(member=>member!==id));
          }}/><span className="chat-avatar person">{initials(name)}</span>{name}</label>;
        })}{!matches.length&&<p>No team members match your search.</p>}</div>
      </>:<p>There are no staff participants available to invite.</p>}
    </fieldset>
    <div className="staff-fields call-composer-fields">{ordinary.slice(3).map(field=><FieldInput key={field.name} field={field}/>)}</div>
    <details className="call-composer-settings"><summary><Icon name="settings" size={16}/>Meeting options</summary><div className="staff-fields">{settings.map(field=><FieldInput key={field.name} field={field}/>)}</div></details>
    {failure&&<p className="form-error" role="alert">{failure}</p>}
    <button className="btn btn-blue" type="submit" disabled={pending}>{pending?"Saving…":action==="start"?"Start call":"Schedule meeting"}</button>
  </form>;
}

export function Calls({data,actor,refresh}:{data:ViewData;actor:Viewer;refresh:()=>void}){
  const [focus,setFocus]=useState(""),[detail,setDetail]=useState<Details|null>(null),[tab,setTab]=useState("Upcoming"),[search,setSearch]=useState("");
  const [dialog,setDialog]=useState(""),[notice,setNotice]=useState(""),[error,setError]=useState(""),[loadError,setLoadError]=useState(""),[busy,setBusy]=useState(false);
  const [guestLink,setGuestLink]=useState("");
  const [manualGuestCopy,setManualGuestCopy]=useState(false);
  const guestLinkInput=useRef<HTMLInputElement>(null);
  const [recordingPlayback,setRecordingPlayback]=useState<{recording:string;url:string}|null>(null);
  const [access,setAccess]=useState<Access|null>(null),[devices,setDevices]=useState<Devices|null>(null),[waiting,setWaiting]=useState(false),[preview,setPreview]=useState(false);
  const [clock,setClock]=useState(Date.now()),[confirmAction,setConfirmAction]=useState<{action:string;employee?:string;recording?:string}|null>(null);
  const [creation,setCreation]=useState({type:"Group",mode:"Video"});
  const version=useRef(0),selected=useRef(focus),joining=useRef(false),prejoinFor=useRef("");selected.current=focus;
  const headerRef=useRef<HTMLHeadingElement>(null),listRef=useRef<HTMLInputElement>(null),layoutRef=useRef<HTMLDivElement>(null);
  const isAdmin=admin(actor),m=detail?.meeting;
  const load=useCallback(async()=>{
    if(!focus)return;
    const request=++version.current;
    let denied=false;
    try{
      const response=await fetch(`/api/workspace/meeting/${encodeURIComponent(focus)}`,{cache:"no-store"});
      denied=[401,403,404,410].includes(response.status);
      const result=await response.json().catch(()=>null);
      if(!response.ok||!result?.meeting)throw new Error(result?.error||"Meeting information could not be refreshed.");
      if(selected.current===focus&&request===version.current){setDetail(result as Details);setLoadError("");}
    }catch(e){
      if(selected.current!==focus||request!==version.current)return;
      setLoadError(e instanceof Error?e.message:"Unable to open this meeting.");
      if(denied){setDetail(null);setAccess(null);setWaiting(false);setRecordingPlayback(null);}
    }
  },[focus]);
  useEffect(()=>{const id=new URLSearchParams(window.location.search).get("meeting");if(id)setFocus(id);},[]);
  useEffect(()=>{setDetail(null);setLoadError("");setPreview(!!focus&&prejoinFor.current===focus);setWaiting(false);setRecordingPlayback(null);void load();},[focus,load]);
  useEffect(()=>{const timer=setInterval(()=>{setClock(Date.now());},m?.started_at&&!m.ended_at?1000:5000);return()=>clearInterval(timer);},[m?.started_at,m?.ended_at]);
  useEffect(()=>{const timer=setInterval(()=>{if(document.visibilityState==="visible"){refresh();void load();}},5000);const onFocus=()=>{refresh();void load();};window.addEventListener("focus",onFocus);return()=>{clearInterval(timer);window.removeEventListener("focus",onFocus);};},[refresh,load]);
  useEffect(()=>{if(detail&&(m?.ended_at||m?.cancelled_at)){setAccess(null);setPreview(false);setWaiting(false);}},[detail,m?.ended_at,m?.cancelled_at]);
  const ownMember=detail?.members.find(member=>member.id===actor.id);
  const join=useCallback(async()=>{
    if(!focus||joining.current)return;joining.current=true;setBusy(true);setError("");
    try{const result=await api("calls/join",{id:focus});if(selected.current!==focus)return;
      if(result.waiting){setWaiting(true);setNotice(result.message);}else{setAccess(result as Access);setWaiting(false);setPreview(false);setNotice("");}await load();refresh();
    }catch(e){setError(e instanceof Error?e.message:"Unable to join the meeting.");setWaiting(false);}finally{joining.current=false;setBusy(false);}
  },[focus,load,refresh]);
  useEffect(()=>{if(waiting&&ownMember?.admitted_at&&!access)void join();},[waiting,ownMember?.admitted_at,access,join]);
  function select(id:string,openDeviceCheck=false){
    if(access)return;
    prejoinFor.current=openDeviceCheck?id:"";
    setFocus(id);setError("");setNotice("");setDevices(null);
    const url=new URL(window.location.href);
    if(id)url.searchParams.set("meeting",id);else url.searchParams.delete("meeting");
    window.history.replaceState(null,"",url);
    if(layoutRef.current&&layoutRef.current.clientWidth<=740)requestAnimationFrame(()=>{
      const control=id?headerRef.current:listRef.current;
      control?.focus({preventScroll:true});
      layoutRef.current?.scrollIntoView({block:"nearest"});
    });
  }
  async function act(action:string,extra:Record<string,unknown>={}){
    if(busy)return;setBusy(true);setError("");setNotice("");
    try{
      const result=await api(`calls/${action}`,{id:focus,...extra});
      setNotice(result.message??(result.url?"Recording access authorized.":"Saved."));
      if(result.url){
        if(action==="play-recording")setRecordingPlayback({recording:String(extra.recording),url:result.url});
        else{const link=document.createElement("a");link.href=result.url;link.rel="noreferrer";link.click();}
      }
      if(result.disconnectRequired||["end","cancel","leave"].includes(action)){setAccess(null);setPreview(false);setWaiting(false);}
      await load();refresh();
    }
    catch(e){setError(e instanceof Error?e.message:"Unable to complete this action.");}finally{setBusy(false);setConfirmAction(null);}
  }
  async function copyLink(id:string){try{await navigator.clipboard.writeText(new URL(`/staff/calls?meeting=${encodeURIComponent(id)}`,window.location.origin).href);setNotice("Meeting link copied. Only invited, active accounts can join.");}catch{setError("The link could not be copied. You can copy the meeting URL from your address bar.");}}
  async function openGuestLink(guest:string){
    if(busy)return;
    setBusy(true);setError("");setNotice("");
    try{
      const response=await api("calls/guest-link",{id:focus,guest});
      if(!response.url)throw new Error("The invitation link is unavailable.");
      setGuestLink(response.url);setManualGuestCopy(false);setDialog("guest-link");
    }catch(reason){setError(reason instanceof Error?reason.message:"The invitation link could not be opened.");}
    finally{setBusy(false);}
  }
  async function copyGuestLink(){
    try{
      await navigator.clipboard.writeText(guestLink);
      setDialog("");setGuestLink("");setNotice("Invitation link copied.");
    }catch{
      guestLinkInput.current?.focus();guestLinkInput.current?.select();setManualGuestCopy(true);
    }
  }
  const policy=data.meetingPolicy;
  const managedRecording=data.recordingCategories!==undefined;
  const creationCategory=(creation.type==="Group"?"Group":creation.mode) as RecordingCategory;
  const allowRecording=managedRecording?data.recordingCategories!.includes(creationCategory):policy?.recording_policy!=="Disabled"&&(isAdmin||policy?.recording_policy==="Hosts"&&["manager","hr"].includes(actor.role));
  const recordRequest=detail?.recordingRequest;
  const enableInvites=!!data.guestInvites;
  const externalFields:Field[]=[
    {name:"externalEmails",label:"External email addresses",type:"textarea",placeholder:"Separate addresses with a comma or a new line",max:6000},
  ];
  const meetingZone=Intl.DateTimeFormat().resolvedOptions().timeZone||actor.timeZone||"UTC";
  const zoneField:Field={name:"timeZone",label:"Meeting time zone (IANA)",value:meetingZone,placeholder:"America/Edmonton",max:70,required:true};
  const fields:Field[]=[{name:"title",label:"Meeting title",required:true,max:100},{name:"type",label:"Call size",options:["One-to-one","Group"],value:"Group",required:true},
    {name:"mode",label:"Call mode",options:["Audio","Video"],value:"Video",required:true},
    ...(data.guestInvites?.canInvite?externalFields:[]),
    ...(enableInvites?[{name:"description",label:"Description",type:"textarea",max:2000},{name:"instructions",label:"Instructions for invitees",type:"textarea",max:1600},zoneField] as Field[]:[]),
    {name:"waiting",label:"Waiting room",options:[["0","Invited people join directly"],["1","A host admits invited people"]],value:"0",required:true},
    {name:"screenSharing",label:"Screen sharing",options:[["Everyone","All permitted participants"],["Host","Hosts only"],["Disabled","Disabled"]],value:"Everyone",required:true},
    ...(allowRecording&&data.recordingStorage?[{name:"recording",label:"Optional recording",options:[["0","Off"],["1","Available under workspace policy"]],value:"0",required:true} as Field]:[])];
  const rows=(data.rows??[]).filter(row=>value(row,"title").toLowerCase().includes(search.toLowerCase())&&(tab==="Past"?!!row.cancelled_at||!!row.ended_at||Date.parse(value(row,"ends_at"))<=clock:!row.cancelled_at&&!row.ended_at&&Date.parse(value(row,"ends_at"))>clock));
  const open=!!m&&!m.ended_at&&!m.cancelled_at&&Date.parse(value(m,"ends_at"))>clock;
  const canJoin=open&&Date.parse(value(m,"starts_at"))-900000<=clock;
  const duration=m?.started_at?elapsed(((m.ended_at?Date.parse(value(m,"ended_at")):clock)-Date.parse(value(m,"started_at")))/1000):"Not started";
  const waitingMembers=(detail?.members??[]).filter(member=>member.requested_at&&!member.admitted_at&&!member.removed_at);
  const invitees=(data.staff??[]).filter(person=>!detail?.members.some(member=>member.id===person.id&&!member.removed_at));
  const connected=(detail?.members.filter(member=>member.connected&&!member.removed_at).length??0)+(detail?.externalGuests?.filter(guest=>guest.connected&&!guest.revoked_at).length??0);
  const organizer=detail?.members.find(person=>person.id===m?.organizer_id)?.name;
  const ownConsent=ownMember?.recording_consent;
  const canRespondToRecording=open&&!!ownMember&&(detail?.recordingAllowed||detail?.recordingActive);
  const consentActions=canRespondToRecording&&<div className="row-actions call-consent-actions">
    {detail?.recordingAllowed&&ownConsent!==1&&<button className="btn btn-outline btn-small" type="button" disabled={busy} onClick={()=>void act("consent",{consent:"1"})}>Give consent</button>}
    {ownConsent!==0&&<button className="btn btn-outline btn-small" type="button" disabled={busy} onClick={()=>void act("consent",{consent:"0"})}>{ownConsent===1?"Withdraw consent":"Decline recording"}</button>}
  </div>;
  return <div className="calls-workspace">
    <div className="calls-title"><div className="calls-heading"><span className="calls-heading-icon"><Icon name="video" size={26}/></span><div><h2>Calls &amp; meetings</h2><p>{access?"Manage your devices, participants and recording for this call.":"Schedule a meeting or start an audio or video call."}</p></div></div>
      {actor.role!=="guest"&&!access&&<div className="row-actions"><button className="btn btn-outline" type="button" onClick={()=>{setCreation({type:"Group",mode:"Video"});setDialog("schedule");}}><Icon name="calendar" size={17}/>Schedule meeting</button><button className="btn btn-blue" type="button" disabled={!data.provider} onClick={()=>{setCreation({type:"Group",mode:"Video"});setDialog("start");}}><Icon name="video" size={17}/>Meet now</button></div>}
    </div>
    {!data.provider&&<div className="calls-setup"><Icon name="plug"/><div><strong>LiveKit connection required</strong><p>Meetings can be scheduled now. A Super Admin can connect LiveKit in Integrations to enable browser audio and video.</p></div>{actor.role==="super_admin"&&<a className="btn btn-outline btn-small" href="/staff/integrations">Connect LiveKit</a>}</div>}
    {error&&<div className="form-error" role="alert"><span>{error}</span><button className="icon-button" type="button" aria-label="Dismiss error" onClick={()=>setError("")}><Icon name="close" size={16}/></button></div>}
    {notice&&<p className="call-notice" role="status"><span>{notice}</span><button className="icon-button" type="button" aria-label="Dismiss message" onClick={()=>setNotice("")}><Icon name="close" size={16}/></button></p>}
    <div ref={layoutRef} className={`calls-layout ${access?"in-call":""}`} data-pane={focus?"detail":"list"}>
      {!access&&<aside className="calls-list" aria-label="Meeting list"><div className="calls-list-heading"><h3>Your meetings</h3><div className="chat-tabs" role="group" aria-label="Meeting schedule">{["Upcoming","Past"].map(label=><button key={label} type="button" aria-pressed={tab===label} onClick={()=>setTab(label)}>{label}</button>)}</div>
        <label className="chat-find"><Icon name="search" size={17}/><span className="sr-only">Find a meeting</span><input ref={listRef} type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Find a meeting" maxLength={100}/></label></div>
        <div className="calls-meeting-list">{rows.map(row=><button className={`call-card ${focus===row.id?"selected":""}`} aria-current={focus===row.id?"true":undefined} key={value(row,"id")} type="button" onClick={()=>select(value(row,"id"))}><span className="icon-tile"><Icon name={row.mode==="Audio"?"phone":"video"} size={19}/></span><span className="call-card-label"><strong>{row.title}</strong><small>{date(actor,row.starts_at)}</small><span>{row.organizer} · {row.mode}</span></span><Icon name="next" size={16}/></button>)}</div>
        {!rows.length&&<Empty icon="calendar" title={search?"No meetings found":`No ${tab.toLowerCase()} meetings`} body={tab==="Upcoming"?"Schedule a meeting or start a call with your team.":"Completed and cancelled meetings will appear here."}/>}
        {(actor.role==="super_admin"||data.guestInvites?.canConfigure||data.recordingSettings)&&<div className="calls-policies">
          {(actor.role==="super_admin"||data.guestInvites?.canConfigure)&&<button className="calls-policy" type="button" onClick={()=>setDialog("policy")}><Icon name="shield" size={17}/>{managedRecording?"External guest policy":"Calling and recording policy"}<Icon name="next" size={15}/></button>}
          {data.recordingSettings&&<button className="calls-policy" type="button" onClick={()=>setDialog("recording-policy")}><Icon name="settings" size={17}/>Recording policy<Icon name="next" size={15}/></button>}
        </div>}
      </aside>}
      <section className="calls-detail" aria-label="Meeting details">
        {!!focus&&!access&&<button className="calls-mobile-back" type="button" onClick={()=>select("")}><Icon name="left" size={17}/>Your meetings</button>}
        {loadError&&<div className="call-sync-alert" role="status"><Icon name="alert" size={16}/><span>{m?"Meeting details may be out of date. ":""}{loadError}</span><button className="text-link" type="button" onClick={()=>void load()}>Retry</button></div>}
        {!m?<div className="call-welcome"><span className="call-welcome-art"><Icon name="video" size={40}/><i><Icon name="shield" size={20}/></i></span><h3 ref={headerRef} tabIndex={-1}>{focus?loadError?"Meeting unavailable":"Opening meeting…":"Select a meeting"}</h3>{!focus&&<p>Open a meeting to see the schedule, check your devices, or review its attendance and recordings.</p>}</div>:<>
          <header className="call-detail-heading"><div><div className="row-actions"><Status>{m.cancelled_at?"Cancelled":!open?"Ended":access?"In call":m.started_at?"Live meeting":"Scheduled"}</Status><span>{m.mode} · {m.waiting_room?"Waiting room on":"Invited access"}</span></div><h3 ref={headerRef} tabIndex={-1}>{m.title}</h3><p>{date(actor,m.starts_at)}{organizer?` · Hosted by ${m.organizer_id===actor.id?"you":organizer}`:""}</p></div><button className="btn btn-outline btn-small" type="button" onClick={()=>void copyLink(focus)}><Icon name="external" size={16}/>Copy staff link</button></header>
          {enableInvites&&!!m.guest_description&&<p className="call-message">{m.guest_description}</p>}
          {enableInvites&&!!m.guest_instructions&&<p className="call-message">{m.guest_instructions}</p>}
          <div className="call-summary"><span><Icon name="clock" size={16}/>{duration}</span><span><Icon name="users" size={16}/>{connected} connected</span><span><Icon name="lock" size={16}/>{m.locked_at?"Locked":"Invited participants only"}</span>{detail?.recordingActive&&<strong className="recording-indicator" role="status"><i/>{detail.stopPending||detail.recordingStatus==="Stopping"?"Recording stop pending":detail.recordingStatus==="Starting"?"Recording starting":"Recording"}</strong>}</div>
          {!access&&canRespondToRecording&&<section className="call-consent" aria-label="Recording consent">
            <div className="call-consent-heading"><strong><Icon name="shield" size={18}/> Recording consent</strong><Status>{ownConsent===1?"Consent given":ownConsent===0?"Declined":"No response"}</Status></div>
            <p>{detail?.consentRequired?"Recording can start after every invited participant gives consent. You can join without agreeing while recording is off.":"This meeting may be recorded under workspace policy. You can decline recording before or during the call."}</p>
            {detail?.recordingAllowed&&<p>{detail.consentText}</p>}
            {consentActions}
          </section>}
          {access?<div className="call-live" data-lk-theme="default"><LiveKitRoom serverUrl={access.serverUrl} token={access.token} audio={access.canPublish&&devices?.audioEnabled?{deviceId:devices.audioDeviceId}:false} video={access.canPublish&&access.mode==="Video"&&devices?.videoEnabled?{deviceId:devices.videoDeviceId}:false} options={{adaptiveStream:true,dynacast:true}} onDisconnected={()=>{setAccess(null);setNotice("You left the call.");refresh();void load();}} onError={e=>setError(e.message)} onMediaDeviceFailure={()=>setError("Camera or microphone access failed. Check your browser permissions and selected device.")}>
            <ConferenceStage mode={access.mode} endsAt={access.endsAt} onError={setError}/>
          </LiveKitRoom></div>:canJoin&&data.provider?<div className="call-join-area">
            {waiting?<div className="call-waiting"><span className="icon-tile"><Icon name="clock" size={24}/></span><h4>Waiting for your host</h4><p>Your request was sent. You’ll join automatically after admission.</p><button className="btn btn-outline btn-small" type="button" onClick={()=>{setWaiting(false);void act("withdraw-request");}}>Stay outside the call</button></div>:<>
              {preview?<div className={`call-prejoin ${m.mode==="Audio"?"audio":""}`} data-lk-theme="default"><PreJoin defaults={{username:actor.name,audioEnabled:true,videoEnabled:m.mode==="Video"}} persistUserChoices={false} joinLabel={busy?"Joining…":"Join meeting"} onError={e=>setError(e.message)} onValidate={()=>!busy} onSubmit={choices=>{setDevices(choices);void join();}}/></div>:<button className="btn btn-blue" type="button" disabled={busy} onClick={()=>setPreview(true)}><Icon name={m.mode==="Audio"?"phone":"video"} size={18}/>{m.waiting_room&&!detail?.host&&!ownMember?.admitted_at?"Check devices and request entry":"Check devices and join"}</button>}
            </>}
          </div>:!access&&open&&data.provider&&<p className="call-message">Joining opens 15 minutes before the scheduled start.</p>}
          {access&&canRespondToRecording&&<section className="call-consent call-live-consent" aria-label="Recording consent"><div className="call-consent-heading"><strong><Icon name="shield" size={18}/>Recording consent</strong><Status>{ownConsent===1?"Consent given":ownConsent===0?"Declined":"No response"}</Status></div>{consentActions}</section>}
          {detail?.host&&open&&<div className="call-host-controls"><strong>Host controls</strong><div className="row-actions"><button className="btn btn-outline btn-small" type="button" disabled={busy} onClick={()=>void act("lock",{locked:m.locked_at?"0":"1"})}><Icon name="lock" size={15}/>{m.locked_at?"Unlock":"Lock joins"}</button><button className="btn btn-outline btn-small" type="button" disabled={detail.recordingActive} onClick={()=>setDialog("invite")}>Invite people</button>
            {enableInvites&&!m.started_at&&<button className="btn btn-outline btn-small" type="button" onClick={()=>setDialog("reschedule")}>Reschedule</button>}
            <button className="btn btn-danger btn-small" type="button" disabled={busy} onClick={()=>setConfirmAction({action:m.started_at?"end":"cancel"})}>{m.started_at?"End for everyone":"Cancel meeting"}</button></div></div>}
          {enableInvites&&!!detail?.externalGuests?.length&&<details className="call-section" open={!access}>
            <summary>External guests · {detail.externalGuests.filter(guest=>!guest.revoked_at).length}</summary>
            {detail.host&&data.guestInvites?.canInvite&&<div className="row-actions">
              <button className="btn btn-outline btn-small" type="button" onClick={()=>void act("guest-delivery")} disabled={busy||!data.guestInvites.emailConfigured}>Process due emails</button>
              {!data.guestInvites.emailConfigured&&<small>Connect a verified Resend sender to send queued invitations.</small>}
            </div>}
            <div className="call-people">{detail.externalGuests.map(guest=><div className="call-person" key={value(guest,"id")}>
              <span className="chat-avatar person"><Icon name="mail" size={15}/></span>
              <div className="call-person-name"><strong>{guest.name}</strong>
                <small>{guest.email?value(guest,"email")+" · ":""}{guest.revoked_at?"Revoked":guest.rsvp}{guest.connected?" · Connected":guest.requested_at&&!guest.admitted_at?" · Waiting for host":""}{!!m.recording_enabled&&(detail.host||isAdmin)?guest.recording_consent===1?" · Consent given":guest.recording_consent===0?" · Recording declined":" · No consent response":""}</small>
                {guest.delivery&&<small>{guest.delivery_event} email · {guest.delivery==="Sent"?"Accepted by Resend":guest.delivery}{guest.delivery_error?(guest.delivery_error==="provider_403"?" · Sender verification or permissions required":" · "+value(guest,"delivery_error").replaceAll("_"," ")):""}</small>}
              </div>
              {detail.host&&open&&!guest.revoked_at&&<div className="row-actions">
                {!!guest.requested_at&&!guest.admitted_at&&<button type="button" className="btn btn-blue btn-small" disabled={busy||!!m.locked_at} onClick={()=>void act("guest-admit",{guest:guest.id})}>Admit</button>}
                <button className="text-link" type="button" onClick={()=>setDialog(`guest-permissions:${guest.id}`)}>Permissions</button>
                {data.guestInvites?.canInvite&&!guest.opened&&guest.rsvp!=="Declined"&&<button className="text-link" type="button" disabled={busy} onClick={()=>void openGuestLink(value(guest,"id"))}>Open invitation link</button>}
                {data.guestInvites?.canInvite&&guest.rsvp!=="Declined"&&!m.started_at&&<button className="text-link" type="button" disabled={busy} onClick={()=>void act("guest-resend",{guest:guest.id})}>Send replacement link</button>}
                <button className="text-link danger" type="button" disabled={busy} onClick={()=>setDialog(`revoke-guest:${guest.id}`)}>Revoke</button>
              </div>}
            </div>)}</div>
          </details>}
          {waitingMembers.length>0&&detail?.host&&open&&<section className="call-waiting-list"><h4>Waiting room · {waitingMembers.length}</h4>{waitingMembers.map(person=><div className="call-person" key={value(person,"id")}><span className="chat-avatar person">{initials(value(person,"name"))}</span><strong>{person.name}</strong><div className="row-actions"><button className="btn btn-blue btn-small" type="button" disabled={busy||!!m.locked_at} onClick={()=>void act("admit",{employee:person.id})}>Admit</button><button className="btn btn-danger btn-small" type="button" disabled={busy} onClick={()=>setConfirmAction({action:"deny",employee:value(person,"id")})}>Deny</button></div></div>)}</section>}
          <details className="call-section" open={!access}><summary><Icon name="users" size={17}/>Participants <span>{detail?.members.filter(person=>!person.removed_at).length}</span></summary><div className="call-people">{detail?.members.filter(person=>!person.removed_at).map(person=><div className="call-person" key={value(person,"id")}><span className="chat-avatar person">{initials(value(person,"name"))}</span><div className="call-person-name"><strong>{person.name}{person.id===actor.id?" (you)":""}</strong><small>{person.id===m.organizer_id?"Organizer":person.co_host?"Co-host":person.role==="guest"?"External guest":"Participant"}{person.connected?" · Connected":""}{!!m.recording_enabled&&(detail.host||isAdmin||person.id===actor.id)?person.recording_consent===1?" · Consent given":person.recording_consent===0?" · Recording declined":" · No consent response":""}</small></div>
            {detail.host&&open&&person.id!==actor.id&&person.id!==m.organizer_id&&(!person.co_host||m.organizer_id===actor.id)&&<div className="row-actions">{!!person.connected&&<button className="text-link" type="button" disabled={busy} onClick={()=>void act("mute",{employee:person.id})}>Mute mic</button>}<button className="text-link" type="button" onClick={()=>setDialog(`permissions:${person.id}`)}>Permissions</button><button className="text-link danger" type="button" onClick={()=>setConfirmAction({action:"remove",employee:value(person,"id")})}>Remove</button></div>}</div>)}</div></details>
          {!!m.recording_enabled&&<section className="call-section call-recording-panel">
            <h4><Icon name="video" size={17}/>Meeting recording</h4>
            <p>{detail?.recordingAllowed?`Recordings are kept for ${m.recording_retention_days} days. Authorized hosts and administrators can open them.`:"Workspace policy currently blocks new recordings for this meeting."}</p>
            {recordRequest&&open&&<p>Host approval <Status>{recordRequest.status}</Status></p>}
            {open&&detail?.canRecord&&!detail.recordingActive&&(!m.started_at||detail.recordingBlocker)&&<p className="call-recording-blocker" role="status"><Icon name="help" size={16}/>{m.started_at?detail.recordingBlocker:"Join the meeting before starting a recording."}</p>}
            {open&&<div className="row-actions">
              {detail?.canRequestRecording&&<button className="btn btn-outline btn-small" type="button" disabled={busy} onClick={()=>void act("record-request")}>Request recording</button>}
              {detail?.canDecideRecording&&recordRequest&&<>
                <button className="btn btn-outline btn-small" type="button" disabled={busy} onClick={()=>void act("record-approve",{request:recordRequest.id})}>Approve recording</button>
                <button className="btn btn-outline btn-small" type="button" disabled={busy} onClick={()=>void act("record-decline",{request:recordRequest.id})}>Decline request</button>
              </>}
              {detail?.canRecord&&!detail.recordingActive&&<button className="btn btn-outline btn-small" type="button" disabled={busy||!m.started_at||!!detail.recordingBlocker} onClick={()=>setConfirmAction({action:"record-start"})}><Icon name="video" size={16}/>Start recording</button>}
              {detail?.canStopRecording&&<button className="btn btn-danger btn-small" type="button" disabled={busy||detail.stopPending} onClick={()=>void act("record-stop")}>Stop recording</button>}
            </div>}
            {(detail?.host||isAdmin)&&<Table rows={detail?.recordings??[]} columns={[{key:"status",title:"Status",render:row=><Status>{row.status}</Status>},{key:"started_at",title:"Started",render:row=>date(actor,row.started_at)},{key:"expires_at",title:"Retention ends",render:row=>date(actor,row.expires_at)}]} empty="No recordings" actions={row=>!row.deleted_at&&<>{row.status==="Complete"&&Date.parse(value(row,"expires_at"))>clock&&<>
              <button className="text-link" type="button" disabled={busy} onClick={()=>void act("play-recording",{recording:row.id})}>Play</button>
              <button className="text-link" type="button" disabled={busy} onClick={()=>void act("download-recording",{recording:row.id})}>Download</button>
            </>}{isAdmin&&!["Starting","Active","Stopping"].includes(value(row,"status"))&&<button className="text-link danger" type="button" onClick={()=>setConfirmAction({action:"delete-recording",recording:value(row,"id")})}>Delete</button>}</>}/>}</section>}
          {(detail?.host||isAdmin)&&<details className="call-section"><summary>Attendance and call history</summary><div className="call-attendance-meta"><span>Started: {date(actor,m.started_at)}</span><span>Ended: {date(actor,m.ended_at)}</span><span>Duration: {duration}</span></div><p>Join and leave records come from signed LiveKit events. People who did not join show no attendance.</p><a className="btn btn-outline btn-small" href={`/api/workspace/meeting-attendance/${encodeURIComponent(focus)}`}><Icon name="file" size={15}/>Download attendance CSV</a><Table rows={detail?.attendance??[]} columns={[{key:"name",title:"Participant"},{key:"first_join",title:"First joined",render:row=>date(actor,row.first_join)},{key:"last_leave",title:"Last left",render:row=>row.connected?"In call":date(actor,row.last_leave)},{key:"seconds",title:"Time in call",render:row=>elapsed(Number(row.seconds))},{key:"connections",title:"Connections"}]} empty="No attendance records"/></details>}
        </>}
      </section>
    </div>
    {(dialog==="schedule"||dialog==="start")&&<Modal title={dialog==="start"?"Start a call":"Schedule a meeting"} close={()=>setDialog("")}>
      {!data.guestInvites?.emailConfigured&&data.guestInvites?.canInvite&&<p>External invitations will be queued until a verified Resend sender is connected.</p>}
        <MeetingComposer action={dialog} people={(data.staff??[]).filter(person=>person.id!==actor.id)} fields={[...fields,...(dialog==="schedule"?[
          {name:"startsAt",label:enableInvites?"Starts (meeting time zone)":"Starts (your device time)",type:"datetime-local",preserveLocalValue:enableInvites,required:true},
          {name:"endsAt",label:enableInvites?"Ends (meeting time zone)":"Ends (your device time)",type:"datetime-local",preserveLocalValue:enableInvites,required:true},
        ]:[])]} onTypeChange={(name,value)=>setCreation(previous=>({...previous,[name]:value}))} finished={result=>{setDialog("");select(result.id??"",dialog==="start");setNotice(result.message??"Meeting saved.");refresh();}}/>
    </Modal>}
    {dialog==="policy"&&<Modal title={enableInvites||managedRecording?"External guest policy":"Calling and recording policy"} close={()=>setDialog("")}>
      <p>External guests can only access the meeting they were invited to. Hosts can revoke access at any time.</p>
      <ActionForm path={enableInvites?"calls/guest-policy":"calls/policy"} fields={[
        {name:"enabled",label:"External invitations",options:[["0","Disabled"],["1","Authorized hosts may invite external guests"]],value:data.guestMeetings?"1":"0",required:true},
        ...(enableInvites?[{name:"admission",label:"Guest verification",options:["Host approval","Invitation only"],value:data.guestInvites?.admission??"Host approval",required:true}] as Field[]:[]),
        ...(!managedRecording&&!enableInvites?[{name:"recordingPolicy",label:"Who may enable and start recording",options:[["Disabled","Recording disabled"],["Admins","Administrators only"],["Hosts","Administrators and manager/HR hosts"]],value:policy?.recording_policy??"Disabled",required:true},{name:"retention",label:"Recording retention days",type:"number",min:1,max:365,value:policy?.recording_retention_days??30,required:true}] as Field[]:[]),
      ]} submit="Save calling policy" refresh={refresh} onDone={()=>setDialog("")}/>
    </Modal>}
    {dialog==="reschedule"&&m&&<Modal title="Reschedule meeting" close={()=>setDialog("")}><ActionForm path="calls/reschedule" extra={{id:focus}} fields={[
      {name:"startsAt",label:"Starts (meeting time zone)",value:meetingLocalStamp(value(m,"starts_at"),value(m,"guest_time_zone")||meetingZone),type:"datetime-local",preserveLocalValue:true,required:true},
      {name:"endsAt",label:"Ends (meeting time zone)",value:meetingLocalStamp(value(m,"ends_at"),value(m,"guest_time_zone")||meetingZone),type:"datetime-local",preserveLocalValue:true,required:true},
      {...zoneField,value:value(m,"guest_time_zone")||meetingZone},
    ]} submit="Save new meeting time" onDone={result=>{setDialog("");setNotice(result.message??"Rescheduled.");void load();refresh();}}/></Modal>}
    {dialog==="guest-link"&&guestLink&&<Modal title="External meeting invitation" close={()=>{setDialog("");setGuestLink("");}}>
      <p>Share this private link with the invited recipient. The first device that opens it can respond to the invitation.</p>
      <div className="staff-fields"><label>Secure invitation link<input ref={guestLinkInput} readOnly value={guestLink} onFocus={event=>event.currentTarget.select()}/></label></div>
      <button type="button" className="btn btn-outline" onClick={()=>void copyGuestLink()}>Copy invitation link</button>
      {manualGuestCopy&&<small role="status">The link is selected for manual copying.</small>}
    </Modal>}
    {dialog.startsWith("revoke-guest:")&&<Modal title="Revoke guest access?" close={()=>setDialog("")}><p>The secure link will expire immediately and the guest will be disconnected.</p><div className="row-actions">
      <button type="button" className="btn btn-outline" onClick={()=>setDialog("")}>Keep invitation</button>
      <button type="button" className="btn btn-danger" disabled={busy} onClick={()=>{const guest=dialog.slice("revoke-guest:".length);setDialog("");void act("guest-revoke",{guest});}}>Revoke access</button>
    </div></Modal>}
    {dialog.startsWith("guest-permissions:")&&(()=>{const guest=detail?.externalGuests?.find(row=>row.id===dialog.slice("guest-permissions:".length));return guest&&<Modal title="External guest permissions" close={()=>setDialog("")}>
      <ActionForm path="calls/guest-permissions" extra={{id:focus,guest:guest.id}} fields={[
        {name:"publish",label:"Microphone and camera",options:[["1","May publish"],["0","Listen and view only"]],value:guest.can_publish,required:true},
        {name:"share",label:"Screen sharing",options:[["1","Allowed within meeting policy"],["0","Disabled"]],value:guest.can_share,required:true},
      ]} submit="Save guest permissions" onDone={()=>{setDialog("");void load();}}/>
    </Modal>;})()}
    {dialog==="recording-policy"&&data.recordingSettings&&<Modal title="Meeting recording policy" close={()=>setDialog("")}><RecordingPolicyForm policy={data.recordingSettings} saved={()=>{setDialog("");setNotice("Recording policy saved.");void load();refresh();}}/></Modal>}
    {recordingPlayback&&<Modal title="Meeting recording" close={()=>setRecordingPlayback(null)}>
      <video className="call-recording-playback" controls preload="metadata" src={recordingPlayback.url} aria-label="Meeting recording"/>
      <button className="text-link" type="button" disabled={busy} onClick={()=>void act("play-recording",{recording:recordingPlayback.recording})}>Refresh playback access</button>
      {error&&<p className="form-error" role="alert">{error}</p>}
    </Modal>}
    {dialog==="invite"&&<Modal title="Invite a participant" close={()=>setDialog("")}>
      {!!invitees.length&&<ActionForm path="calls/invite" fields={[{name:"employee",label:"Internal participant",options:options(invitees),required:true}]} extra={{id:focus}} submit="Send internal invitation" onDone={()=>{setDialog("");void load();refresh();}}/>}
      {data.guestInvites?.canInvite&&<ActionForm path="calls/guest-invite" fields={externalFields.map(field=>({...field,required:true}))} extra={{id:focus}} submit="Queue external invitations" onDone={result=>{setDialog("");setNotice(result.message??"Invitation queued.");void load();refresh();}}/>}
      {!invitees.length&&!data.guestInvites?.canInvite&&<p>Everyone available to invite is already listed as a participant.</p>}
    </Modal>}
    {dialog.startsWith("permissions:")&&(()=>{const person=detail?.members.find(member=>member.id===dialog.split(":")[1]);return person&&<Modal title={`Permissions for ${person.name}`} close={()=>setDialog("")}><ActionForm path="calls/permissions" fields={[{name:"publish",label:"Microphone and camera",options:[["1","May publish"],["0","Listen and view only"]],value:person.can_publish,required:true},{name:"share",label:"Screen sharing",options:[["1","Allowed within meeting sharing policy"],["0","Disabled"]],value:person.can_share,required:true},...(m?.organizer_id===actor.id&&person.role!=="guest"?[{name:"coHost",label:"Host permissions",options:[["0","Participant"],["1","Co-host"]],value:person.co_host,required:true} as Field]:[])]} extra={{id:focus,employee:person.id}} submit="Save permissions" onDone={()=>{setDialog("");void load();}}/></Modal>;})()}
    {confirmAction&&<Modal title={confirmAction.action==="record-start"?"Start recording?":confirmAction.action==="delete-recording"?"Permanently delete recording?":confirmAction.employee?"Remove meeting access?":"End this meeting?"} close={()=>setConfirmAction(null)}><p>{confirmAction.action==="record-start"?"Recording will capture voices and any permitted video or shared screens. The server checks workspace policy, host approval when required and participant decisions before it starts.":confirmAction.action==="delete-recording"?"This permanently removes the recording from private storage.":confirmAction.employee?"This person will be disconnected and cannot rejoin unless invited again.":"All participants will be disconnected. This meeting cannot be reopened."}</p><div className="row-actions"><button className="btn btn-outline" type="button" disabled={busy} onClick={()=>setConfirmAction(null)}>Keep as is</button><button className="btn btn-danger" type="button" disabled={busy} onClick={()=>void act(confirmAction.action,{employee:confirmAction.employee,recording:confirmAction.recording})}>{busy?"Working…":"Confirm"}</button></div></Modal>}
  </div>;
}
