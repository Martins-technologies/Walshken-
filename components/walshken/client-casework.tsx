"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, BriefcaseBusiness, CalendarDays, ClipboardList, LockKeyhole, MessageSquare, Search, ShieldCheck, UsersRound } from "lucide-react";
import { countries } from "@/lib/walshken/catalog";
import { StaffClientFinance } from "./client-finance";
import { ClientCalls, ClientCallSettings } from "./client-calls";
import { StaffClientDocuments } from "./client-documents";
import { ClientCompanyControls } from "./client-company-controls";
import { dateText, Empty, FieldInput, Status, type Field } from "./ui";
import styles from "./client-casework.module.css";

type CaseRow = {
  id:string; reference:string; title:string; service:string; country:string; customer_name?:string; representative_name:string;
  representative_designation:string; assigned_employee_id:string|null; communication_enabled:boolean; internal_status:string;
  client_status:string; revision:number; created_at:string; updated_at:string; submitted_at:string|null; application_submitted_on:string|null;
};
type Registration = {id:string; name:string; email:string; created_at:string};
type Assignment = {id:string; name:string; assigned_at:string; ended_at:string|null};
type Update = {id:string; title:string; body:string; proposed_status:string|null; submission_date:string|null; author:string; created_by:string; decision:string; review_note:string|null; created_at:string};
type Entry = {id:string; body:string; created_at:string; author?:string; direction?:string; display_name?:string};
type Requirement = {id:string; title:string; instructions:string; due_on:string; status:string};
type History = {id:string; event:string; created_at:string; actor:string|null};
type PrivacyRequest = {id:string; type:string; reason:string; status:string; revision:number; public_response:string|null; customer_name:string; reference:string|null; created_at:string};
type LegalHold = {id:string; customer_name:string; reference:string|null; reason:string; created_at:string; created_by:string; released_at:string|null};
type PrivacyData = {privacyPolicy:{id:string; notice:string; reference:string; retention_days:number; published_at:string}|null; privacyRequests:PrivacyRequest[];legalHolds:LegalHold[];viewer:string};
type DetailData = {case:CaseRow;customer:Registration;employees:(Registration&{employee_no:string})[];assignments:Assignment[];notes:Entry[];requests:Requirement[];updates:Update[];messages:Entry[];events:History[];canManage:boolean;canPrivacy:boolean;viewer:string};
type Registry = {cases:CaseRow[];registrations:Registration[];canCreate:boolean};
type Action = (action:string, payload:Record<string,unknown>)=>Promise<boolean>;

const internal = ["New","Assessing","In progress","Waiting for client","Ready to submit","Submitted to authority","Complete","Closed"];
const publication = ["Received","Under review","Action required","In progress","Submitted","Decision available","Complete","Closed"];
const countryNames = new Map(countries.map(item=>[item.code,item.name]));
const countryOptions:readonly (readonly [string,string])[] = countries.map(item=>[item.code,item.name] as const);
const actionDecisions:Record<string,string[]> = {Submitted:["Under review","Approved","Declined"],"Under review":["Approved","Declined"],Approved:["Completed"]};

function Controls({ fields, action, label, initial, submit, children }: {
  fields:Field[];action:string;label:string;initial?:Record<string,unknown>;submit:Action;children?:ReactNode;
}) {
  const [saving,setSaving]=useState(false);
  async function send(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=event.currentTarget,body=Object.fromEntries(new FormData(form));
    setSaving(true);
    try { if(await submit(action,{...body,...initial}))form.reset(); }
    finally { setSaving(false); }
  }
  return <form onSubmit={send} className={styles.form}>
    {fields.length>0&&<div className={styles.fields}>{fields.map(field=><FieldInput key={field.name} field={field}/>)}</div>}
    {children}
    <button className="btn btn-blue btn-small" type="submit" disabled={saving}>{saving?"Saving…":label}</button>
  </form>;
}
function Disclosure({title,children}:{title:string;children:ReactNode}){
  return <details className={styles.disclosure}><summary>{title}</summary><div>{children}</div></details>;
}

function CasePrivacy({data,submit}:{data:PrivacyData;submit:Action}){
  return <div className={styles.details}>
    <section className={styles.card}><h3><ShieldCheck size={18}/> Privacy notice and retention</h3>
      {data.privacyPolicy?<><p>Published {dateText(data.privacyPolicy.published_at)} · {data.privacyPolicy.retention_days} days</p><p className={styles.copy}>{data.privacyPolicy.notice}</p>
        <a className="text-link" href={data.privacyPolicy.reference} rel="noreferrer" target="_blank">View policy reference</a></>:<p>A notice must be published before a client can record consent.</p>}
      <Disclosure title="Publish a policy version"><Controls fields={[
        {name:"notice",label:"Approved client privacy notice",type:"textarea",required:true,max:12000,value:data.privacyPolicy?.notice},
        {name:"reference",label:"Approved privacy policy URL",type:"url",required:true,max:500,value:data.privacyPolicy?.reference},
        {name:"retentionDays",label:"Policy retention days",type:"number",min:1,max:36500,required:true,value:data.privacyPolicy?.retention_days},
      ]} submit={submit} action="privacy-policy" label="Publish privacy notice"/></Disclosure>
    </section>
    <section className={styles.card}><h3><ClipboardList size={18}/> Client privacy requests</h3>
      {data.privacyRequests.length?data.privacyRequests.map(row=><Disclosure key={row.id} title={`${row.type} · ${row.customer_name} · ${row.status}`}>
        <p className={styles.copy}>{row.reason}</p><p>{row.reference??"Account request"} · {dateText(row.created_at)}</p>
        {row.public_response&&<p className={styles.copy}>{row.public_response}</p>}
        {!!actionDecisions[row.status]?.length&&<Controls key={row.revision} fields={[
          {name:"decision",label:"Decision",options:actionDecisions[row.status],required:true},
          {name:"reason",label:"Private review evidence",type:"textarea",required:true,max:3000},
          {name:"response",label:"Client-facing response",type:"textarea",required:true,max:1500},
          ...(row.type==="Document deletion"&&row.status==="Approved"?[{name:"disposal",label:"Completed document disposal ID",required:true,max:80}]:[]),
        ]} initial={{request:row.id,revision:row.revision}} submit={submit} action="privacy-decision" label="Record privacy decision"/>}
      </Disclosure>):<p>There are no submitted privacy requests.</p>}
    </section>
    <section className={styles.card}><h3><LockKeyhole size={18}/> Account and case legal holds</h3>
      {data.legalHolds.length?data.legalHolds.map(row=><Disclosure key={row.id} title={`${row.customer_name} · ${row.reference??"Account hold"} · ${row.released_at?"Released":"Active"}`}>
        <p className={styles.copy}>{row.reason}</p><p>Placed {dateText(row.created_at)}{row.released_at?" · Released "+dateText(row.released_at):""}</p>
        {!row.released_at&&data.viewer!==row.created_by&&<Controls fields={[{name:"reason",label:"Authority and reason for release",type:"textarea",required:true,max:2000}]} initial={{hold:row.id}} submit={submit} action="privacy-release" label="Release legal hold"/>}
      </Disclosure>):<p>No account or case legal holds have been recorded.</p>}
    </section>
  </div>;
}

function CaseDetails({data,submit,refresh}:{data:DetailData;submit:Action;refresh:()=>void}){
  const [tab,setTab]=useState("activity");
  const row=data.case, additions={case:row.id,revision:row.revision};
  const staffOptions=data.employees.map(person=>[person.id,`${person.name} · ${person.employee_no}`] as const);
  return <div className={styles.details}>
    <section className={styles.caseHeader}>
      <div><p>{row.reference} · {countryNames.get(row.country)??row.country}</p><h2>{row.title}</h2><p>{row.service} · {data.customer.name}</p></div>
      <div className={styles.indicators}><span>Client status <Status>{row.client_status}</Status></span><span>Internal stage <Status>{row.internal_status}</Status></span></div>
      <dl>
        <div><dt>Assigned representative</dt><dd>{row.representative_name||"Unassigned"}</dd></div>
        <div><dt>Client email</dt><dd>{data.customer.email}</dd></div>
        <div><dt>Intake received</dt><dd>{row.submitted_at?dateText(row.submitted_at):dateText(row.created_at)}</dd></div>
        <div><dt>Application submitted</dt><dd>{row.application_submitted_on?dateText(row.application_submitted_on):"Awaiting published date"}</dd></div>
      </dl>
    </section>
    <nav className={styles.caseTabs} aria-label="Case work areas">{[["activity","Activity"],["documents","Documents"],["communication","Communication"],["administration","Assignment and controls"]].map(([value,label])=><button type="button" key={value} aria-pressed={tab===value} onClick={()=>setTab(value)}>{label}</button>)}</nav>
    {tab==="activity"&&<div className={styles.detailColumns}>
      <section className={styles.card}><h3><ClipboardList size={18}/> Client-visible progress</h3>
        {row.client_status!=="Closed"&&<Disclosure title="Propose a client update"><Controls fields={[
          {name:"title",label:"Update title",required:true,max:150},{name:"body",label:"Client-visible wording",required:true,type:"textarea",max:5000},
          {name:"status",label:"Client status change",options:publication},{name:"submissionDate",label:"Application submitted on",type:"date"},
        ]} initial={additions} submit={submit} action="propose" label="Send for review"/></Disclosure>}
        {data.updates.length?data.updates.map(update=><div key={update.id} className={styles.entry}>
          <header><strong>{update.title}</strong><Status>{update.decision}</Status></header>
          <p className={styles.copy}>{update.body}</p><small>{update.author} · {dateText(update.created_at,true)}</small>
          {update.proposed_status&&<p>Proposed status {update.proposed_status}{update.submission_date?" · Filed "+dateText(update.submission_date):""}</p>}
          {update.review_note&&<p className={styles.copy}>Internal review note · {update.review_note}</p>}
          {data.canManage&&update.created_by!==data.viewer&&update.decision==="Pending"&&
            <Disclosure title="Review this update"><Controls fields={[
              {name:"decision",label:"Publish or return",options:[["Published","Publish to client"],["Returned","Return to staff"]],required:true},
              {name:"reviewNote",label:"Private review note",type:"textarea",required:true,max:1500},
            ]} initial={{...additions,update:update.id}} submit={submit} action="review" label="Record review"/></Disclosure>}
        </div>):<p>There are no proposed or published updates.</p>}
      </section>
      <section className={styles.card}><h3><LockKeyhole size={18}/> Internal workspace</h3><p>Case notes and internal stages are visible to authorized staff.</p>
        <Disclosure title="Change internal stage"><Controls key={row.revision} fields={[{name:"status",label:"Internal stage",options:internal,value:row.internal_status,required:true}]} initial={additions} submit={submit} action="internal-status" label="Save internal stage"/></Disclosure>
        <Disclosure title="Add private note"><Controls fields={[{name:"body",label:"Private staff note",type:"textarea",required:true,max:5000}]} initial={additions} submit={submit} action="note" label="Save private note"/></Disclosure>
        {data.notes.map(note=><div className={styles.entry} key={note.id}><p className={styles.copy}>{note.body}</p><small>{note.author} · {dateText(note.created_at,true)}</small></div>)}
      </section>
    </div>}
    {tab==="documents"&&<section className={styles.card}><h3><ClipboardList size={18}/> Document requirements</h3>
      {row.client_status!=="Closed"&&<Disclosure title="Request a document"><Controls fields={[
        {name:"title",label:"Document or requirement",required:true,max:150},{name:"instructions",label:"Client instructions",type:"textarea",required:true,max:2000},
        {name:"due",label:"Deadline",type:"date",required:true},
      ]} initial={additions} submit={submit} action="request-document" label="Send document request"/></Disclosure>}
      {data.requests.length?data.requests.map(item=><article className={styles.entry} key={item.id}>
        <header><strong>{item.title}</strong><Status>{item.status}</Status></header><p className={styles.copy}>{item.instructions}</p><p className={styles.iconLine}><CalendarDays size={14}/> Due {dateText(item.due_on)}</p>
        {["Open","Replacement requested"].includes(item.status)&&<><Disclosure title="Edit requirement and deadline"><Controls key={row.revision} fields={[
          {name:"title",label:"Document or requirement",required:true,max:150,value:item.title},
          {name:"instructions",label:"Client instructions",type:"textarea",required:true,max:2000,value:item.instructions},
          {name:"due",label:"Deadline",type:"date",required:true,value:item.due_on},
        ]} initial={{...additions,request:item.id}} submit={submit} action="edit-document" label="Save requirement"/></Disclosure>
          <Disclosure title="Cancel document requirement"><Controls fields={[]} initial={{...additions,request:item.id}} submit={submit} action="cancel-document" label="Cancel requirement"/></Disclosure></>}
      </article>):<p>No document requirements are attached to this case.</p>}
      <StaffClientDocuments caseId={row.id} onChanged={refresh}/>
    </section>}
    {tab==="communication"&&<section className={styles.card}><h3><MessageSquare size={18}/> Client messages</h3>
      {data.messages.length?<div className={styles.thread}>{data.messages.map(message=><article key={message.id} data-origin={message.direction} className={styles.message}><strong>{message.display_name}</strong><p>{message.body}</p><small>{dateText(message.created_at,true)}</small></article>)}</div>:<p>No messages have been sent.</p>}
      {row.assigned_employee_id&&row.communication_enabled&&row.client_status!=="Closed"&&<Controls fields={[
        {name:"body",label:"Message to the client",type:"textarea",required:true,max:4000},
      ]} initial={additions} submit={submit} action="message" label="Send message"/>}
      <ClientCalls audience="staff" caseId={row.id}/>
    </section>}
    {tab==="administration"&&<div className={styles.detailColumns}>
      <section className={styles.card}><h3><UsersRound size={18}/> Representative and access</h3>
        {data.canManage?<><Controls key={row.revision} fields={[
          {name:"employee",label:"Staff representative",options:staffOptions,value:row.assigned_employee_id},
          {name:"representativeName",label:"Company-approved display name",value:row.representative_name,max:100},
          {name:"designation",label:"Approved professional designation",value:row.representative_designation,max:100},
        ]} initial={additions} submit={submit} action="assign" label="Save representative"/>
        {row.client_status!=="Closed"&&<Disclosure title="Edit case details"><Controls key={row.revision} fields={[
          {name:"title",label:"Case title",required:true,max:160,value:row.title},
          {name:"service",label:"Immigration service or category",required:true,max:150,value:row.service},
          {name:"country",label:"Country",required:true,options:countryOptions,value:row.country},
        ]} initial={additions} submit={submit} action="case-details" label="Save case details"/></Disclosure>}
        <Disclosure title={row.communication_enabled?"Pause client communication":"Enable client communication"}>
          <Controls fields={[]} initial={{...additions,enabled:!row.communication_enabled}} submit={submit} action="client-access" label={row.communication_enabled?"Pause communication":"Enable communication"}/>
        </Disclosure>{data.canPrivacy&&<Disclosure title="Place a legal hold"><Controls fields={[{name:"reason",label:"Legal hold reason",type:"textarea",required:true,max:2000}]} initial={{customer:data.customer.id,case:row.id}} submit={submit} action="privacy-hold" label="Place legal hold"/></Disclosure>}</>:<p>Assignment changes require a case administrator.</p>}
        {data.assignments.map(assignment=><div key={assignment.id} className={styles.entry}><strong>{assignment.name}</strong><p>{dateText(assignment.assigned_at,true)} · {assignment.ended_at?"Ended "+dateText(assignment.ended_at,true):"Current assignment"}</p></div>)}
      </section>
      <section className={styles.card}><h3><ClipboardList size={18}/> Case audit</h3>
        <ul className={styles.events}>{data.events.map(event=><li key={event.id}><span>{event.event}</span><small>{[event.actor,dateText(event.created_at,true)].filter(Boolean).join(" · ")}</small></li>)}</ul>
        {data.canPrivacy&&<ClientCompanyControls customerId={data.customer.id} caseId={row.id}/>}
      </section>
    </div>}
    <StaffClientFinance caseId={row.id}/>
  </div>;
}

export function ClientCasework() {
  const [target,setTarget]=useState("");
  const [query,setQuery]=useState("");
  const [find,setFind]=useState("");
  const [tab,setTab]=useState("cases");
  const [version,setVersion]=useState(0);
  const [registry,setRegistry]=useState<Registry|null>(null);
  const [detail,setDetail]=useState<DetailData|null>(null);
  const [privacy,setPrivacy]=useState<PrivacyData|null>(null);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [loading,setLoading]=useState(true);
  const refresh=()=>setVersion(current=>current+1);
  useEffect(()=>{
    const read=()=>setTarget(new URLSearchParams(window.location.search).get("case")??"");
    read();window.addEventListener("popstate",read);
    return ()=>window.removeEventListener("popstate",read);
  },[]);
  useEffect(()=>{
    const abort=new AbortController();
    setLoading(true);
    const params=target?new URLSearchParams({case:target}):tab==="privacy"?new URLSearchParams({view:"privacy"}):new URLSearchParams({q:query});
    fetch("/api/client-casework?"+params,{cache:"no-store",signal:abort.signal})
      .then(async response=>{const data=await response.json();if(!response.ok)throw Error(data.error||"Could not load client casework.");return data;})
      .then(data=>{if(abort.signal.aborted)return;if(target)setDetail(data);else if(tab==="privacy")setPrivacy(data);else setRegistry(data);setError("");})
      .catch(reason=>{if(!abort.signal.aborted){setError(reason.message);if(target)setDetail(null);}})
      .finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    return ()=>abort.abort();
  },[query,target,tab,version]);
  function open(caseId:string){
    setTarget(caseId);setDetail(null);setError("");setNotice("");
    window.history.pushState(null,"","/staff/client-casework"+(caseId?"?"+new URLSearchParams({case:caseId}):""));
  }
  const submit:Action=async(action,body)=>{
    setError("");setNotice("");
    try {
      const response=await fetch("/api/client-casework",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...body,action})});
      const data=await response.json();
      if(!response.ok)throw Error(data.error||"The action could not be completed.");
      if(action==="create"&&data.id)open(data.id);
      setNotice(data.message||"Saved.");refresh();
      return true;
    } catch(reason){setError(reason instanceof Error?reason.message:"The action could not be completed.");return false;}
  };
  return <section className={styles.workspace} aria-label="Client casework">
    <div className={styles.heading}><span><BriefcaseBusiness size={23}/></span><div><h2>Client casework</h2><p>Manage immigration cases, requests, and approved client updates.</p></div>
      {target&&<button type="button" className="btn btn-outline btn-small" onClick={()=>open("")}><ArrowLeft size={15}/> Back to cases</button>}
    </div>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {notice&&<p className="form-success" role="status">{notice}</p>}
    {target?(detail?.case.id===target?<CaseDetails key={target} data={detail} submit={submit} refresh={refresh}/>:loading&&<p role="status">Loading case…</p>):<>
      <nav className={styles.caseTabs} aria-label="Casework sections">
        <button type="button" aria-pressed={tab==="cases"} onClick={()=>setTab("cases")}>Case register</button>
        <button type="button" aria-pressed={tab==="calls"} onClick={()=>setTab("calls")}>Client calls</button>
        {registry?.canCreate&&<><button type="button" aria-pressed={tab==="registrations"} onClick={()=>setTab("registrations")}>Client registrations</button>
          <button type="button" aria-pressed={tab==="privacy"} onClick={()=>setTab("privacy")}>Privacy and retention</button></>}
      </nav>
      {(tab==="cases"||tab==="registrations")&&<form className={styles.search} onSubmit={event=>{event.preventDefault();setQuery(find.trim());}}>
        <label><Search size={17}/><input value={find} onChange={event=>setFind(event.target.value)} type="search" maxLength={100} aria-label="Search client cases" placeholder={tab==="cases"?"Search by reference, case, or client":"Search registrations by name or email"}/></label>
        <button className="btn btn-outline btn-small">Search</button>
      </form>}
      {loading&&!registry&&<p role="status">Loading casework…</p>}
      {tab==="cases"&&registry&&(registry.cases.length?<div className={styles.registry}>
        {registry.cases.map(row=><button key={row.id} type="button" className={styles.caseRow} onClick={()=>open(row.id)}>
          <span><strong>{row.title}</strong><small>{row.reference} · {row.customer_name}</small></span>
          <span><strong>{row.representative_name||"Awaiting assignment"}</strong><small>{countryNames.get(row.country)??row.country} · {row.service}</small></span>
          <Status>{row.internal_status}</Status><ArrowRight size={17} aria-hidden="true"/>
        </button>)}
      </div>:<Empty title="No client cases to show" body={query?"Try another name or reference.":"Cases in your assignment scope will appear here."} icon="project"/>)}
      {tab==="registrations"&&registry&&<section className={styles.card}><h3><UsersRound size={18}/> Client registrations</h3>
        {registry.registrations.length?registry.registrations.map(row=><Disclosure key={row.id} title={`${row.name} · ${row.email}`}>
          <p>Registered {dateText(row.created_at,true)}</p>
          <Controls fields={[
            {name:"title",label:"Case title",required:true,max:160},{name:"service",label:"Immigration service or case category",required:true,max:150},
            {name:"country",label:"Country",required:true,options:countryOptions},{name:"message",label:"Optional internal background",type:"textarea",max:5000},
          ]} initial={{customer:row.id}} submit={submit} action="create" label="Create case"/>
          <Disclosure title="Place an account legal hold"><Controls fields={[{name:"reason",label:"Legal hold reason",type:"textarea",required:true,max:2000}]} initial={{customer:row.id}} submit={submit} action="privacy-hold" label="Place account hold"/></Disclosure>
          <ClientCompanyControls customerId={row.id}/>
        </Disclosure>):<p>No registrations match the current search.</p>}
      </section>}
      {tab==="privacy"&&privacy&&<CasePrivacy data={privacy} submit={submit}/>}
      {tab==="calls"&&<section className={styles.card}><h3><MessageSquare size={18}/> Client communications</h3>
        <ClientCalls audience="staff"/>
        {registry?.canCreate&&<ClientCallSettings/>}
      </section>}
    </>}
  </section>;
}
