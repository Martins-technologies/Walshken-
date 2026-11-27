"use client";

import Link from "next/link";
import { useEffect, useId, useState, type FormEvent } from "react";
import { browserAppointmentZone, formatAppointmentTime } from "@/lib/walshken/client-appointment-time";
import { Icon } from "./brand";
import { clientRequest } from "./client-access";
import { ClientEmpty } from "./client-ui";
import styles from "./client-appointments.module.css";

type Schedule = {
  appointments:Appointment[]; slots:Slot[]; representative:string|null; canSchedule:boolean; canManageAvailability:boolean;
};
type Appointment = {
  id:string; representative:string; startsAt:string; endsAt:string; timeZone:string; mode:"Audio"|"Video";
  status:"Booked"|"Past"|"Cancelled"|"Completed"; revision:number; canChange:boolean; canComplete:boolean; canJoin:boolean;
};
type Slot = {
  id:string; startsAt:string; endsAt:string; timeZone:string; mode:"Audio"|"Video"; occupied:boolean;
};
type Audience = "client"|"staff";
const api = (audience:Audience) => `/api/client-appointments/${audience}`;
const portal = (caseId:string,appointment?:string) => `/customer/appointments?case=${encodeURIComponent(caseId)}${appointment?`&appointment=${encodeURIComponent(appointment)}`:""}`;

function useSchedule(audience:Audience,caseId:string,summary=false) {
  const [result,setResult]=useState<{caseId:string;data:Schedule}|null>(null);
  const [failure,setFailure]=useState<{caseId:string;error:string}|null>(null);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    if(!caseId) return;
    const control=new AbortController();
    async function refresh() {
      try {
        const data=await clientRequest<Schedule>(`${api(audience)}?case=${encodeURIComponent(caseId)}${summary?"&view=summary":""}`,undefined,control.signal);
        if (!control.signal.aborted) {setResult({caseId,data});setFailure(null);}
      } catch (error) {
        if (!control.signal.aborted) setFailure({caseId,error:(error as Error).message});
      }
    }
    void refresh();
    const interval=summary ? undefined : window.setInterval(()=>{ if (document.visibilityState==="visible") void refresh(); },60_000);
    return ()=>{control.abort();if(interval!==undefined)window.clearInterval(interval);};
  },[audience,caseId,revision,summary]);
  return {data:result?.caseId===caseId ? result.data : null,
    error:failure?.caseId===caseId ? failure.error : "", refresh:()=>setRevision(value=>value+1)};
}

function safeZone(value:string) {
  try {
    return new Intl.DateTimeFormat("en",{timeZone:value}).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
function ZoneInput({value,onChange,required=false,name}:{value:string;onChange:(value:string)=>void;required?:boolean;name?:string}) {
  const optionsId=useId();
  const defaults=["UTC","America/Toronto","America/Vancouver","Europe/Paris","Asia/Karachi","Asia/Kolkata","Asia/Dubai"];
  const zones=typeof Intl.supportedValuesOf==="function" ? Intl.supportedValuesOf("timeZone") : defaults;
  return <label className={styles.field}><span>{name==="timeZone"?"Appointment time zone":"Display time zone"}</span>
    <input list={optionsId} name={name} value={value} onChange={event=>onChange(event.target.value)} required={required} maxLength={70} placeholder="UTC"/>
    <datalist id={optionsId}>{["UTC",...zones.filter(zone=>zone!=="UTC")].map(zone=><option key={zone} value={zone}/>)}</datalist>
  </label>;
}

export function ClientAppointmentSummary({caseId}:{caseId:string}) {
  const {data,error}=useSchedule("client",caseId,true);
  const [zone,setZone]=useState("UTC");
  useEffect(()=>setZone(browserAppointmentZone()),[]);
  const upcoming=data?.appointments[0];
  return <section className="client-card" aria-label="Next appointment"><div className="client-card-heading"><div>
    <h2>Appointments</h2><p>Your next consultation.</p>
  </div><Link className="client-text" href={portal(caseId,upcoming?.id)}>Schedule <Icon name="right" size={16}/></Link></div>
    {error ? <p className="client-small">Appointments could not be loaded. Open the schedule to retry.</p>
      : upcoming ? <div className="client-representative"><span className="client-symbol"><Icon name="calendar"/></span>
        <div><strong>{formatAppointmentTime(upcoming.startsAt,upcoming.endsAt,zone)}</strong><span>{upcoming.representative} · {upcoming.mode} · {zone}</span></div>
      </div> : data ? <p className="client-small">You have no upcoming appointments.</p> : <p role="status" className="client-loading">Loading…</p>}
  </section>;
}

function SchedulePanel({audience,caseId,appointmentId}:{audience:Audience;caseId:string;appointmentId?:string}) {
  const {data,error,refresh}=useSchedule(audience,caseId);
  const [zone,setZone]=useState("UTC"),[publishZone,setPublishZone]=useState("UTC");
  const [selection,setSelection]=useState(""),[changing,setChanging]=useState<Appointment|null>(null),[cancelId,setCancelId]=useState("");
  const [pending,setPending]=useState(false),[operationError,setOperationError]=useState(""),[notice,setNotice]=useState("");
  useEffect(()=>{ const browserZone=browserAppointmentZone();setZone(browserZone);setPublishZone(browserZone); },[]);
  const validZone=safeZone(zone);
  const displayZone=validZone ?? "UTC";
  const staff=audience==="staff";
  const available=data?.slots.filter(slot=>!slot.occupied) ?? [];
  const upcoming=data?.appointments.filter(item=>item.status==="Booked") ?? [];
  const history=data?.appointments.filter(item=>item.status!=="Booked") ?? [];
  const times=(entry:Slot|Appointment)=>formatAppointmentTime(entry.startsAt,entry.endsAt,displayZone);

  async function post(action:string,payload:Record<string,unknown>={}) {
    setPending(true);setOperationError("");setNotice("");
    try {
      const result=await clientRequest<{href?:string}>(api(audience),{...payload,case:caseId,action});
      if (result.href) {
        if (!/^(?:\/customer\/contact\?|\/staff\/client-casework\?tab=communication&)case=[a-z0-9.%_-]+$/i.test(result.href)) throw new Error("The secure meeting link could not be opened.");
        window.location.assign(result.href);
        return true;
      }
      if (action==="book" || action==="reschedule") {setChanging(null);setSelection("");}
      if (action==="cancel") setCancelId("");
      setNotice(({publish:"Availability published.",withdraw:"Availability withdrawn.",book:"Appointment booked.",
        reschedule:"Appointment rescheduled.",cancel:"Appointment cancelled.",complete:"Appointment completed."} as Record<string,string>)[action] ?? "Saved.");
      return true;
    } catch (failure) {
      setOperationError((failure as Error).message);
      return false;
    } finally {setPending(false);refresh();}
  }
  const target=(item:Appointment)=>({appointment:item.id,revision:item.revision});

  async function publish(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form=event.currentTarget, fields=new FormData(form);
    const ok=await post("publish",{localStart:fields.get("localStart"),timeZone:publishZone,duration:Number(fields.get("duration")),mode:fields.get("mode")});
    if(ok) form.reset();
  }

  function appointmentRows(items:Appointment[]) {
    return <ul className={styles.rows}>{items.map(item=><li key={item.id} id={`appointment-${item.id}`}
      className={appointmentId===item.id?styles.highlight:undefined}>
      <div><strong>{times(item)}</strong><p>{item.representative} · {item.mode} call · {item.status}</p></div>
      <div className={styles.actions}>
        {item.canJoin&&<button className="btn btn-blue" type="button" disabled={pending} onClick={()=>void post("join",target(item))}>Open secure meeting</button>}
        {item.status==="Booked"&&<a className="client-text" href={`${api(audience)}?case=${encodeURIComponent(caseId)}&appointment=${encodeURIComponent(item.id)}&view=calendar`}>Add to calendar</a>}
        {item.canChange && cancelId!==item.id && <>
          <button className="client-text" type="button" disabled={pending || !available.length} onClick={()=>{setChanging(item);setSelection("");document.getElementById("appointment-booking")?.scrollIntoView({block:"nearest"});}}>Reschedule</button>
          <button className="client-text" type="button" disabled={pending} onClick={()=>setCancelId(item.id)}>Cancel appointment</button>
        </>}
        {item.canChange && cancelId===item.id && <>
          <button className="btn btn-outline" type="button" disabled={pending} onClick={()=>void post("cancel",target(item))}>Confirm cancellation</button>
          <button className="client-text" type="button" disabled={pending} onClick={()=>setCancelId("")}>Keep booking</button>
        </>}
        {item.canComplete && <button className="client-text" type="button" disabled={pending} onClick={()=>void post("complete",target(item))}>Mark completed</button>}
      </div>
    </li>)}</ul>;
  }

  return <div className={styles.root}>
    {error && <p role="alert" className={styles.failure}>{error} <button className="client-text" type="button" onClick={refresh}>Retry</button></p>}
    {operationError && <p role="alert" className={styles.failure}>{operationError}</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {!data && !error && <p className={styles.empty} role="status">Loading appointments…</p>}
    {data && <>
      <section className={styles.panel}><header className={styles.header}><div><h2>{staff?"Consultation schedule":"Your consultations"}</h2>
        <p>{data.representative ? `Book with ${data.representative}.` : "The case team will enable appointment booking when a representative is available."}</p></div>
        <ZoneInput value={zone} onChange={setZone}/>
      </header>
      {!validZone && <p className={styles.empty}>Choose a valid time zone. Times are currently shown in UTC.</p>}
      {upcoming.length ? appointmentRows(upcoming) : <ClientEmpty title="No appointments booked" icon="calendar"/>}
      {upcoming.some(item=>!item.canJoin) && <p className={styles.help}>The secure meeting opens 10 minutes before the appointment. Only the client and assigned representative can open it.</p>}
      </section>

      {staff && data.canManageAvailability && <section className={styles.panel}><div className={styles.header}><div><h2>Publish availability</h2><p>Publish an available time for the assigned representative.</p></div></div>
        <form method="post" onSubmit={publish} className={styles.form}>
          <label className={styles.field}><span>Start date and time</span><input required name="localStart" type="datetime-local" step={60}/></label>
          <ZoneInput name="timeZone" value={publishZone} onChange={setPublishZone} required/>
          <label className={styles.field}><span>Length</span><select name="duration" defaultValue="30">{[15,30,45,60,90,120].map(length=><option key={length} value={length}>{length} minutes</option>)}</select></label>
          <label className={styles.field}><span>Call format</span><select name="mode"><option>Video</option><option>Audio</option></select></label>
          <button type="submit" className="btn btn-blue" disabled={pending}>Publish time</button>
        </form>
        {!!data.slots.length && <ul className={styles.rows}>{data.slots.map(slot=><li key={slot.id}><div><strong>{times(slot)}</strong><p>{slot.mode} · {slot.occupied?"Booked":"Available"}</p></div>
          {!slot.occupied && <button className="client-text" type="button" disabled={pending} onClick={()=>void post("withdraw",{slot:slot.id})}>Withdraw time</button>}
        </li>)}</ul>}
      </section>}

      {data.canSchedule && <section className={styles.panel} id="appointment-booking">
        <div className={styles.header}><div><h2>{changing ? "Reschedule consultation" : staff ? "Book for this client" : "Book a consultation"}</h2>
          {changing&&<p>Current appointment · {times(changing)}</p>}</div>
          {changing&&<button className="client-text" type="button" onClick={()=>{setChanging(null);setSelection("");}}>Keep current time</button>}
        </div>
        {available.length ? <form method="post" className={styles.form} onSubmit={event=>{
          event.preventDefault();if(selection)void post(changing?"reschedule":"book",{...(changing?target(changing):{}),slot:selection});
        }}>
          <label className={styles.field}><span>Available in {displayZone}</span><select required value={selection} onChange={event=>setSelection(event.target.value)}>
            <option value="">Choose an appointment time</option>{available.map(slot=><option key={slot.id} value={slot.id}>{times(slot)} · {slot.mode}</option>)}
          </select></label><button className="btn btn-blue" type="submit" disabled={pending||!selection}>{changing?"Confirm new time":"Book consultation"}</button>
        </form> : <p className={styles.empty}>No times are available. {staff?"Publish a time above.":"Check back or contact your case team."}</p>}
      </section>}

      <section className={styles.panel}><div className={styles.header}><div><h2>Appointment history</h2></div></div>
        {history.length ? appointmentRows(history) : <p className={styles.empty}>Past and cancelled appointments will appear here.</p>}
      </section>
    </>}
  </div>;
}

export function ClientAppointments({caseId,appointmentId}:{caseId:string;appointmentId?:string}) {
  return <SchedulePanel key={caseId} audience="client" caseId={caseId} appointmentId={appointmentId}/>;
}

export function StaffClientAppointments({caseId}:{caseId:string}) {
  return <SchedulePanel key={caseId} audience="staff" caseId={caseId}/>;
}
