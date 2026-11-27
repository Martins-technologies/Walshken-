"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "./brand";
import { communicationDate, communicationRequest } from "./client-conversations";
import styles from "./client-communication.module.css";

const kinds=["Support request","Complaint","Consultation feedback","Service rating","Case closure feedback"] as const;
const statuses=["New","In review","Responded","Closed"] as const;
type Kind=typeof kinds[number];
type Status=typeof statuses[number];
type Case={id:string;title:string;reference?:string;client_status?:string};
type Consultation={id:string;case_id:string;starts_at:string;time_zone:string;reference:string;title:string};
type Entry={id:string;case_id:string|null;appointment_id:string|null;kind:Kind;title:string;body:string;rating:number|null;status:Status;created_at:string;updated_at:string;revision?:number;reference?:string;customer_name?:string};
type Reply={id:string;submission_id:string;body:string;status:Status;created_at:string};
type ClientFeedbackView={entries:Entry[];replies:Reply[];cases:Case[];consultations:Consultation[]};
type AdminFeedbackView={entries:Entry[];replies:Reply[];report:{from:string;to:string;totals:{submissions:number;complaints:number;outstanding:number;average:string|null};byType:{kind:Kind;submissions:number;closed:number;average:string|null}[]}};
const clientRoute="/api/client-feedback/client",staffRoute="/api/client-feedback/staff";
const shortLink=(id:string)=>"?id="+encodeURIComponent(id);
const formValues=(form:HTMLFormElement)=>Object.fromEntries(new FormData(form));

function EntrySummary({item}:{item:Entry}){
  return <><strong>{item.title}</strong><small>{item.kind}{item.reference?" · "+item.reference:""}{item.customer_name?" · "+item.customer_name:""}</small></>;
}
function EntryDetails({entry,replies}:{entry:Entry;replies:Reply[]}){
  return <article className={styles.feedbackDetail}>
    <header><div><h3>{entry.title}</h3><p>{entry.kind}{entry.reference?" · "+entry.reference:""}</p></div><span className={styles.badge}>{entry.status}</span></header>
    <p>{entry.body}</p>
    <small>{communicationDate(entry.created_at)}{entry.rating!==null?" · "+entry.rating+" of 5":""}</small>
    {replies.length>0&&<ul className={styles.replyHistory}>
      {replies.map(reply=><li key={reply.id}><small>Walshken · {communicationDate(reply.created_at)}</small><p>{reply.body}</p></li>)}
    </ul>}
  </article>;
}

export function ClientFeedback({caseId,cases:initialCases=[]}:{caseId?:string;cases?:readonly {id:string;title:string}[]}){
  const [view,setView]=useState<ClientFeedbackView|null>(null),[kind,setKind]=useState<Kind>("Support request");
  const [active,setActive]=useState(""),[error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false);
  const nonce=useRef<string|null>(null);
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    try{const result=await communicationRequest<ClientFeedbackView>(clientRoute,undefined,signal);if(!signal?.aborted){setView(result);setError("");}}
    catch(reason){if(!signal?.aborted)setError((reason as Error).message);}
  },[]);
  useEffect(()=>{
    const controller=new AbortController();
    setActive(new URLSearchParams(window.location.search).get("feedback")??"");
    void refresh(controller.signal);
    return()=>controller.abort();
  },[refresh]);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(busy)return;
    const form=event.currentTarget;
    nonce.current??=crypto.randomUUID();
    setBusy(true);setError("");setNotice("");
    try{
      const result=await communicationRequest<{id:string}>(clientRoute,{...formValues(form),kind,requestId:nonce.current});
      nonce.current=null;form.reset();setActive(result.id);setKind("Support request");await refresh();setNotice("Your submission is in the support queue.");
    }catch(reason){setError((reason as Error).message);}
    finally{setBusy(false);}
  }
  const entry=view?.entries.find(item=>item.id===active),needsRating=kind!=="Support request"&&kind!=="Complaint";
  const cases=(view?.cases??initialCases as Case[]).filter(item=>kind!=="Case closure feedback"||["Complete","Closed"].includes(item.client_status??""));
  const missingContext=kind==="Consultation feedback"&&!view?.consultations.length || kind==="Case closure feedback"&&!cases.length;
  return <div className={styles.feedbackLayout}>
    <section className={styles.panel}>
      <header className={styles.heading}><Icon name="message" size={20}/><div><h2>Support & feedback</h2><p>Request help, raise a concern or tell us about your experience.</p></div></header>
      <form className={styles.form} method="post" onSubmit={submit} onChange={()=>{nonce.current=null;}}>
        <label>Type<select value={kind} onChange={event=>setKind(event.target.value as Kind)} disabled={busy}>{kinds.map(option=><option key={option}>{option}</option>)}</select></label>
        {kind==="Consultation feedback"?<label>Completed consultation
          <select name="appointment" required disabled={busy||!view?.consultations.length} defaultValue="">
            <option value="" disabled>{view?.consultations.length?"Choose your appointment":"No consultation awaiting feedback"}</option>
            {view?.consultations.map(item=><option value={item.id} key={item.id}>{item.title} · {communicationDate(item.starts_at)}</option>)}
          </select>
        </label>:<label>{kind==="Case closure feedback"?"Completed or closed case":"Related case (optional)"}
          <select name="case" required={kind==="Case closure feedback"} key={kind} disabled={busy} defaultValue={cases.some(item=>item.id===caseId)?caseId:""}>
            <option value="">{kind==="Case closure feedback"?"Choose a case":"No case selected"}</option>
            {cases.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </label>}
        {needsRating&&<label>Rating<select name="rating" required disabled={busy} defaultValue="">
          <option value="" disabled>Choose a rating</option><option value="5">5 — Excellent</option><option value="4">4 — Good</option>
          <option value="3">3 — Fair</option><option value="2">2 — Poor</option><option value="1">1 — Very poor</option>
        </select></label>}
        <label>Subject<input name="title" minLength={3} maxLength={140} required disabled={busy}/></label>
        <label>Details<textarea name="body" minLength={3} maxLength={4000} rows={4} required disabled={busy}/></label>
        {error&&<p className={styles.error} role="alert">{error}</p>}
        {notice&&<p className={styles.success} role="status">{notice}</p>}
        <footer><button type="submit" className="btn btn-blue btn-small" disabled={busy||missingContext}>{busy?"Submitting…":"Send to Walshken"}</button></footer>
      </form>
    </section>
    <section className={styles.panel}>
      <header className={styles.heading}><Icon name="file" size={20}/><div><h2>Your submissions</h2><p>Review progress and any replies from the support team.</p></div></header>
      {!view&&!error?<p className={styles.empty} role="status">Loading your history…</p>:!view?.entries.length?<p className={styles.empty}>No submissions yet.</p>:<ul className={styles.inbox}>
        {view.entries.map(item=><li key={item.id}><button type="button" aria-pressed={item.id===active} onClick={()=>setActive(item.id===active?"":item.id)}>
          <span><EntrySummary item={item}/></span><small>{item.status}</small>
        </button></li>)}
      </ul>}
      {entry&&<EntryDetails entry={entry} replies={view?.replies.filter(reply=>reply.submission_id===entry.id)??[]}/>}
    </section>
  </div>;
}

export function StaffClientFeedback(){
  const [view,setView]=useState<AdminFeedbackView|null>(null),[detail,setDetail]=useState<AdminFeedbackView|null>(null);
  const [active,setActive]=useState(""),[filter,setFilter]=useState(""),[period,setPeriod]=useState({from:"",to:""});
  const [error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false);
  const [detailBusy,setDetailBusy]=useState(false);
  useEffect(()=>setActive(new URLSearchParams(window.location.search).get("feedback")??""),[]);
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    try{
      const params=new URLSearchParams();
      if(filter)params.set("status",filter);
      if(period.from)params.set("from",period.from);
      if(period.to)params.set("to",period.to);
      const result=await communicationRequest<AdminFeedbackView>(staffRoute+"?"+params.toString(),undefined,signal);
      if(!signal?.aborted){setView(result);setError("");}
    }catch(reason){if(!signal?.aborted)setError((reason as Error).message);}
  },[period.from,period.to,filter]);
  const loadDetail=useCallback(async(signal?:AbortSignal)=>{
    if(!active)return;
    setDetailBusy(true);
    try{const result=await communicationRequest<AdminFeedbackView>(staffRoute+shortLink(active),undefined,signal);if(!signal?.aborted)setDetail(result);}
    catch(reason){if(!signal?.aborted)setError((reason as Error).message);}
    finally{if(!signal?.aborted)setDetailBusy(false);}
  },[active]);
  useEffect(()=>{const controller=new AbortController();void refresh(controller.signal);return()=>controller.abort();},[refresh]);
  useEffect(()=>{
    const controller=new AbortController();
    setDetail(null);setNotice("");void loadDetail(controller.signal);
    return()=>controller.abort();
  },[loadDetail]);
  async function update(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const row=detail?.entries[0];
    if(!row||busy)return;
    const form=event.currentTarget;
    setBusy(true);setError("");setNotice("");
    try{
      await communicationRequest(staffRoute,{...formValues(form),id:row.id,revision:row.revision});form.reset();
      await Promise.all([refresh(),loadDetail()]);setNotice("The submission was updated.");
    }catch(reason){setError((reason as Error).message);}
    finally{setBusy(false);}
  }
  const row=detail?.entries[0],summary=view?.report;
  return <section className={styles.panel}>
    <header className={styles.heading}><Icon name="file" size={20}/><div><h2>Client feedback</h2><p>Review confidential support requests, complaints and service ratings.</p></div></header>
    <form method="post" className={styles.form} onSubmit={event=>{
      event.preventDefault();
      const values=formValues(event.currentTarget);
      setPeriod({from:String(values.from??""),to:String(values.to??"")});
    }}>
      <div className={styles.filters}>
        <label>Queue status<select value={filter} onChange={event=>setFilter(event.target.value)}><option value="">All statuses</option>{statuses.map(status=><option key={status}>{status}</option>)}</select></label>
        <label>Report from<input type="date" name="from" defaultValue={summary?.from}/></label>
        <label>Report to<input type="date" name="to" defaultValue={summary?.to}/></label>
        <button type="submit" className="btn btn-outline btn-small">Apply report dates</button>
      </div>
    </form>
    {summary&&<><dl className={styles.metrics} aria-label="Feedback totals">
      <div><dt>Submissions</dt><dd>{summary.totals.submissions}</dd></div><div><dt>Complaints</dt><dd>{summary.totals.complaints}</dd></div>
      <div><dt>Outstanding</dt><dd>{summary.totals.outstanding}</dd></div><div><dt>Average rating</dt><dd>{summary.totals.average===null?"—":summary.totals.average+" / 5"}</dd></div>
    </dl>
    {summary.byType.length>0&&<div className={styles.tableWrap}><table><caption>Submissions by type</caption>
      <thead><tr><th scope="col">Type</th><th scope="col">Received</th><th scope="col">Closed</th><th scope="col">Rating</th></tr></thead>
      <tbody>{summary.byType.map(item=><tr key={item.kind}><th scope="row">{item.kind}</th><td>{item.submissions}</td><td>{item.closed}</td><td>{item.average??"—"}</td></tr>)}</tbody>
    </table></div>}</>}
    {!view&&!error?<p className={styles.empty} role="status">Loading feedback…</p>:view?.entries.length?<ul className={styles.inbox}>
      {view.entries.map(item=><li key={item.id}><button type="button" disabled={busy} aria-pressed={item.id===active} onClick={()=>setActive(item.id===active?"":item.id)}>
        <span><EntrySummary item={item}/></span><small>{item.status}</small>
      </button></li>)}
    </ul>:!error&&<p className={styles.empty}>No submissions match this queue.</p>}
    {active&&detailBusy&&!row&&<p className={styles.empty} role="status">Loading secure details…</p>}
    {row&&<><EntryDetails entry={row} replies={detail?.replies??[]}/>
      <form method="post" className={styles.form} key={row.id+"|"+row.revision} onSubmit={update}>
        <label>Status<select name="status" defaultValue={row.status==="Closed"?"In review":row.status==="New"?"In review":row.status} disabled={busy}>
          {(row.status==="Closed"?["In review"]:statuses.filter(status=>status!=="New")).map(status=><option key={status}>{status}</option>)}
        </select></label>
        <label>Reply visible to the client<textarea name="body" minLength={3} maxLength={4000} rows={3} disabled={busy}/></label>
        <footer><button type="submit" className="btn btn-blue btn-small" disabled={busy}>{busy?"Saving…":"Save update"}</button></footer>
      </form>
    </>}
    {error&&<p className={styles.error} role="alert">{error}</p>}
    {notice&&<p className={styles.success} role="status">{notice}</p>}
  </section>;
}
