"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { countries } from "@/lib/walshken/catalog";
import { Icon } from "./brand";
import { clientRequest } from "./client-access";
import { ClientAuthenticator } from "./client-account-options";
import { ClientEmpty, dateLabel, type ClientCase } from "./client-ui";

type Profile = Record<string,string|string[]>;
type ProfileData = {profile:Profile;version:number;verifiedFields:string[];requiredFields:string[];completion:number;history:{id:string;actor:string;action:string;fields:string[];createdAt:string}[]};
type Session = {id:string;device:string;createdAt:string;lastSeenAt:string;expiresAt:string;endedAt:string|null;current:boolean};
type Notification = {id:string;title:string;body:string;href:string;createdAt:string;readAt:string|null;delivery:string};
type SecurityEvent = {id:string;event:string;createdAt:string;sessionId:string|null};
type AlertsData = {notifications:Notification[];unread:number;preferences:{email:boolean}};
type PrivacyData = {
  privacyPolicy:{id:string;notice:string;reference:string;retention_days:number;published_at:string}|null;
  privacyRequests:{id:string;case_id:string|null;type:string;status:string;public_response:string|null;reason:string;created_at:string}[];
  consents:{id:string;case_id:string|null;policy_id:string;decision:string;created_at:string}[];
};
const formLabels:Record<string,string>={name:"Full legal name",email:"Verified email",dob:"Date of birth",phone:"Phone number",address:"Residential address",countryOfBirth:"Country of birth",countryOfResidence:"Country of residence",citizenships:"Citizenships",passportNumber:"Passport number",passportCountry:"Passport issuing country",immigrationHistory:"Relevant immigration history",immigrationStatus:"Current immigration status",language:"Preferred communication language",emergencyName:"Emergency contact name",emergencyPhone:"Emergency contact phone"};
const groups=[["Personal information",["name","email","dob","phone","address","countryOfBirth","countryOfResidence","citizenships","language"]],["Passport & immigration",["passportNumber","passportCountry","immigrationStatus","immigrationHistory"]],["Emergency contact",["emergencyName","emergencyPhone"]]] as const;

function Feedback({error,notice}:{error:string;notice?:string}){
  return <>{error&&<p className="client-alert" role="alert">{error}</p>}{notice&&<p className="client-success" role="status">{notice}</p>}</>;
}
function ProfileField({field,data}:{field:string;data:ProfileData}){
  const isVerified=data.verifiedFields.includes(field),required=data.requiredFields.includes(field);
  const value=data.profile[field]??"";
  const country=["countryOfBirth","countryOfResidence","passportCountry","citizenships"].includes(field);
  const multiple=field==="citizenships";
  const textArea=["address","immigrationHistory"].includes(field);
  const type=field==="dob"?"date":field==="email"?"email":["phone","emergencyPhone"].includes(field)?"tel":"text";
  return <label className={textArea||multiple?"client-full":undefined}><span>{formLabels[field]} {!required&&!isVerified&&<small className="client-field-note">Optional</small>}{isVerified&&<small className="client-field-note">Company verified</small>}</span>
    {country?<select name={field} multiple={multiple} defaultValue={value} disabled={isVerified} required={required} size={multiple?5:undefined}>
      {!multiple&&<option value="">Select a country or territory</option>}{countries.map(item=><option key={item.code} value={item.code}>{item.name}</option>)}
    </select>:textArea?<textarea name={field} defaultValue={String(value)} rows={3} maxLength={field==="address"?600:2000} disabled={isVerified} required={required}/>
    :<input type={type} name={field} defaultValue={String(value)} disabled={isVerified} required={required} maxLength={field==="passportNumber"?30:160} autoComplete={field==="name"?"name":field==="phone"?"tel":field==="dob"?"bday":undefined}/>}
    {multiple&&<small>Choose up to eight countries.</small>}
  </label>;
}
export function ClientAccount(){
  const [data,setData]=useState<ProfileData>(),[error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false);
  const load=useCallback(async()=>{try{setData(await clientRequest<ProfileData>("/api/customer/profile"));setError("");}catch(e){setError((e as Error).message);}},[]);
  useEffect(()=>{void load();},[load]);
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(!data)return;
    const form=new FormData(event.currentTarget);
    const values=Object.fromEntries(form.entries());
    const changed:Record<string,unknown>={...values,version:data.version};
    if(!data.verifiedFields.includes("citizenships"))changed.citizenships=form.getAll("citizenships");
    setBusy(true);setError("");setNotice("");
    try{await clientRequest("/api/customer/profile",changed);setNotice("Your profile has been saved.");await load();}
    catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }
  return <><Feedback error={error}/>{!data ?!error&&<p className="client-loading" role="status">Loading your profile…</p>:<>
    <section className="client-card"><div className="client-card-heading"><div><h2>Profile completion</h2><p>Based on the required details saved to your account.</p></div><strong>{data.completion}%</strong></div>
      <progress aria-label="Profile completion" value={data.completion} max={100}/><p className="client-small">To change a company-verified field, request a correction in <Link href="/customer/security">Security & privacy</Link>.</p>
    </section>
    <form method="post" key={data.version} onSubmit={save}>
      {groups.map(([title,fields])=><section className="client-card" key={title}><div className="client-card-heading"><h2>{title}</h2></div><div className="client-form client-form-grid">{fields.map(field=><ProfileField key={field} field={field} data={data}/>)}</div></section>)}
      <div className="client-form-actions"><button className="btn btn-blue" disabled={busy}>{busy?"Saving…":"Save profile"}</button>{notice&&<p role="status" className="client-success">{notice}</p>}</div>
    </form>
    <section className="client-card"><div className="client-card-heading"><h2>Profile history</h2></div>
      {data.history.length?<ul className="client-list">{data.history.map(item=><li key={item.id}><div><strong>{item.action}</strong><p>{item.fields.map(field=>formLabels[field]??field).join(", ")}</p><small>{item.actor} · {dateLabel(item.createdAt)}</small></div></li>)}</ul>:<ClientEmpty icon="history" title="No profile changes recorded"/>}
    </section>
  </>}</>;
}
export function ClientAlerts({onChanged}:{onChanged:()=>void}){
  const [data,setData]=useState<AlertsData>(),[error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false);
  const load=useCallback(()=>clientRequest<AlertsData>("/api/customer/notifications").then(setData).catch(e=>setError(e.message)),[]);
  useEffect(()=>{void load();},[load]);
  async function action(path:string,body:Record<string,unknown>){
    setBusy(true);setError("");setNotice("");
    try{const response=await clientRequest<{message?:string}>("/api/customer/"+path,body);setNotice(response.message??"Notification status updated.");await load();onChanged();}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <><Feedback error={error} notice={notice}/>
    <section className="client-card"><div className="client-card-heading"><div><h2>Notification center</h2><p>{data?.unread??0} unread updates</p></div>{Boolean(data?.unread)&&<button className="btn btn-outline" type="button" disabled={busy} onClick={()=>void action("notification-read",{all:true})}>Mark all as read</button>}</div>
      {data?.notifications.length?<ul className="client-list">{data.notifications.map(item=><li key={item.id}><div><Link href={item.href}><strong>{item.title}</strong></Link><p>{item.body}</p><small>{dateLabel(item.createdAt)}{!item.readAt?" · Unread":""}{["Queued","Processing","Accepted","Retry","Failed","Delivered","Delayed","Bounced","Complained"].includes(item.delivery)?` · Email ${item.delivery.toLowerCase()}`:""}</small></div>{!item.readAt&&<button className="client-text" type="button" disabled={busy} onClick={()=>void action("notification-read",{id:item.id})}>Mark read</button>}</li>)}</ul>:data?<ClientEmpty icon="bell" title="No notifications yet"/>:!error&&<p className="client-loading" role="status">Loading notifications…</p>}
    </section>
    {data&&<section className="client-card"><div className="client-card-heading"><div><h2>Email preferences</h2><p>Optional alerts contain a sign-in link without your case details.</p></div></div><label className="client-switch"><input type="checkbox" checked={data.preferences.email} disabled={busy} onChange={e=>void action("notification-preferences",{email:e.target.checked})}/> Email me about new updates</label></section>}
  </>;
}
export function ClientSecurity({cases,person}:{cases:ClientCase[];person:{email:string}}){
  const [sessions,setSessions]=useState<Session[]>(),[privacy,setPrivacy]=useState<PrivacyData>(),[error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false),[emailChallenge,setEmailChallenge]=useState(""),[requestType,setRequestType]=useState("Data access");
  const [events,setEvents]=useState<SecurityEvent[]>([]);
  const load=useCallback(async()=>{
    const results=await Promise.allSettled([clientRequest<{sessions:Session[];events:SecurityEvent[]}>("/api/customer/sessions"),clientRequest<PrivacyData>("/api/client-cases")]);
    if(results[0].status==="fulfilled"){setSessions(results[0].value.sessions);setEvents(results[0].value.events);}else setError(results[0].reason.message);
    if(results[1].status==="fulfilled")setPrivacy(results[1].value);else setError(results[1].reason.message);
  },[]);
  useEffect(()=>{void load();},[load]);
  async function send(path:string,data:Record<string,unknown>,then?:(response:{challengeId?:string;message?:string})=>void){
    setBusy(true);setError("");setNotice("");
    try{const result=await clientRequest<{challengeId?:string;message?:string}>(path,data);setNotice(result.message??"Your changes have been saved.");then?.(result);await load();}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  function form(event:FormEvent<HTMLFormElement>,path:string,extra:Record<string,unknown>={},then?:(response:{challengeId?:string;message?:string})=>void){
    event.preventDefault();const target=event.currentTarget;
    void send(path,{...Object.fromEntries(new FormData(target)),...extra},data=>{target.reset();then?.(data);});
  }
  const decision=privacy?.consents?.find(item=>!item.case_id&&item.policy_id===privacy.privacyPolicy?.id);
  return <><Feedback error={error} notice={notice}/>
    <section className="client-card"><div className="client-card-heading"><div><h2>Devices & sessions</h2><p>Review sign-ins and end a session you no longer use.</p></div>{sessions?.some(item=>!item.current&&!item.endedAt)&&<button className="btn btn-outline" type="button" disabled={busy} onClick={()=>void send("/api/customer/session-revoke-others",{})}>End other sessions</button>}</div>
      {sessions?.length?<ul className="client-list">{sessions.map(item=><li key={item.id}><div><strong>{item.device??"Browser"}</strong><p>{item.current?"This session":item.endedAt?"Ended":"Signed in"} · {dateLabel(item.createdAt)}</p>{item.lastSeenAt&&<small>Last activity {dateLabel(item.lastSeenAt)}</small>}</div>{!item.current&&!item.endedAt&&<button className="client-text" type="button" disabled={busy} onClick={()=>void send("/api/customer/session-revoke",{id:item.id})}>End session</button>}</li>)}</ul>:sessions?<ClientEmpty icon="lock" title="No session history"/>:!error&&<p className="client-loading" role="status">Loading session history…</p>}
      {events.length>0&&<details className="client-disclosure"><summary>Recent security activity</summary><ul className="client-list">{events.map(item=><li key={item.id}><strong>{item.event}</strong><small>{dateLabel(item.createdAt)}</small></li>)}</ul></details>}
    </section>
    <ClientAuthenticator/>
    <section className="client-card"><div className="client-card-heading"><div><h2>Email & password</h2><p>Signed in as {person.email}</p></div></div>
      <div className="client-form-actions"><Link className="client-text" href="/customer/reset">Reset password <Icon name="right" size={16}/></Link></div>
      <details className="client-disclosure"><summary>Confirm your password for sensitive actions</summary><form method="post" className="client-form" onSubmit={event=>form(event,"/api/customer/reauthenticate")}><label>Password<input name="password" type="password" autoComplete="current-password" required/></label><div><button className="btn btn-blue" disabled={busy}>Confirm password</button></div></form></details>
      <details className="client-disclosure"><summary>Change password</summary><form method="post" className="client-form" onSubmit={event=>form(event,"/api/customer/password",{},()=>window.location.assign("/customer/sign-in"))}>
        <label>Current password<input name="currentPassword" type="password" autoComplete="current-password" required maxLength={160}/></label>
        <label>New password<input name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={160}/></label>
        <label>Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={160}/></label>
        <div><button className="btn btn-blue" disabled={busy}>Change password and sign out</button></div>
      </form></details>
      <details className="client-disclosure"><summary>Change email address</summary>
        <form method="post" className="client-form" key={emailChallenge||"init"} onSubmit={event=>form(event,emailChallenge?"/api/customer/email-change-verify":"/api/customer/email-change",emailChallenge?{challengeId:emailChallenge}:{},data=>{setEmailChallenge(data.challengeId??"");if(emailChallenge)window.location.reload();})}>
          {emailChallenge?<label>One-time code<input name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required/></label>:<>
            <label>New email address<input name="newEmail" type="email" maxLength={254} required/></label>
            <label>Current password<input name="currentPassword" type="password" autoComplete="current-password" required/></label>
          </>}
          <div className="client-form-actions"><button className="btn btn-blue" disabled={busy}>{emailChallenge?"Confirm email change":"Send verification code"}</button>{emailChallenge&&<button className="client-text" type="button" onClick={()=>setEmailChallenge("")}>Start again</button>}</div>
        </form>
      </details>
    </section>
    <section className="client-card"><div className="client-card-heading"><div><h2>Privacy notice & consent</h2><p>Read the current policy and review your decision.</p></div></div>
      {privacy?.privacyPolicy?<><details className="client-disclosure"><summary>Read the privacy notice</summary><p className="client-preserve">{privacy.privacyPolicy.notice}</p><a className="client-text" href={privacy.privacyPolicy.reference} target="_blank" rel="noreferrer">Policy reference <Icon name="external" size={15}/></a><p className="client-small">Published {dateLabel(privacy.privacyPolicy.published_at)} · Retention policy {privacy.privacyPolicy.retention_days} days</p></details>
      <div className="client-form-actions"><button className="btn btn-outline" disabled={busy||decision?.decision==="Accepted"} onClick={()=>void send("/api/client-cases",{action:"consent",decision:"Accepted",policyRevision:privacy.privacyPolicy?.id})}>Record consent</button><button className="client-text" disabled={busy||decision?.decision!=="Accepted"} onClick={()=>void send("/api/client-cases",{action:"consent",decision:"Withdrawn",policyRevision:privacy.privacyPolicy?.id})}>Withdraw consent</button>{decision&&<span className="client-badge">{decision.decision} · {dateLabel(decision.created_at)}</span>}</div></>:<p className="client-small">No privacy notice has been published. You can still submit a privacy request.</p>}
    </section>
    <section className="client-card"><div className="client-card-heading"><div><h2>Privacy requests</h2><p>Request a copy, correction, deletion or account closure for company review.</p></div></div>
      <form method="post" className="client-form client-form-grid" onSubmit={event=>form(event,"/api/client-cases",{action:"privacy-request"})}>
       <label>Request type<select name="type" value={requestType} onChange={e=>setRequestType(e.target.value)}>{["Data access","Data export","Document deletion","Account closure","Correction"].map(type=><option key={type}>{type}</option>)}</select></label>
       <label>Case scope<select name="case" required={requestType==="Document deletion"} defaultValue=""><option value="">Entire account</option>{cases.map(item=><option value={item.id} key={item.id}>{item.reference} · {item.title}</option>)}</select></label>
       <label className="client-full">Request details<textarea name="reason" rows={3} maxLength={2000} required/></label>
       <div><button className="btn btn-blue" disabled={busy}>Submit privacy request</button></div>
      </form>
      {Boolean(privacy?.privacyRequests.length)&&<ul className="client-list">{privacy?.privacyRequests.map(item=><li key={item.id}><div><strong>{item.type} · {item.status}</strong><p>{item.public_response??item.reason}</p><small>{dateLabel(item.created_at)}</small></div>
       {["Approved","Completed"].includes(item.status)&&["Data access","Data export"].includes(item.type)&&<a className="client-text" href={`/api/client-cases?export=${encodeURIComponent(item.id)}`}>Download export <Icon name="download" size={16}/></a>}</li>)}</ul>}
    </section>
  </>;
}
