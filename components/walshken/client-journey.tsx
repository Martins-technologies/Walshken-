"use client";

import Link from "next/link";
import {useCallback,useEffect,useState,type FormEvent,type ReactNode} from "react";
import {countries} from "@/lib/walshken/catalog";
import {translateClient,type ClientLocale} from "@/lib/walshken/client-locales";
import {clientRequest} from "./client-access";
import {ClientEmpty,dateLabel} from "./client-ui";
import styles from "./client-journey.module.css";

type Milestone = {id:string;stage_title:string;state:string;details:string;next_action:string;event_on:string|null;decided_at:string|null};
type Review = Milestone & {decision:string;review_note:string;submitted_by:string;submitted_at:string};
type Stage = {id:string;title:string;description:string;position:number;enabled:boolean;revision:number};
type ActionKind = "confirmation"|"profile"|"documents"|"agreements"|"payments"|"appointments";
type Action = {id:string;caseId?:string;reference?:string;title:string;details:string;dueOn?:string|null;kind:ActionKind;revision?:number;status?:string};
type Task = {id:string;title:string;details:string;due_on:string|null;action_kind:ActionKind;status:string;revision:number};
type SupportingDocument = {id:string;filename:string;category:string};
type Member = {id:string;revision:number;name:string;relationship:string;hasPassport:boolean;updatedAt:string;documents:SupportingDocument[]};
type Family = {dependants:Member[];availableDocuments:SupportingDocument[]};
type FamilyDetails = {name:string;relationship:string;birthDate:string;passport:string;passportCountry:string;passportExpiry:string};
type FamilyEdit = {id:string;revision:number;details:FamilyDetails};
type Journey = {actions:Action[];milestones:Milestone[];family:Family|null};
type Casework = {milestones:Review[];tasks:Task[];family:Family;stages:Stage[];canReview:boolean;canConfigure:boolean;staffId:string};
type Save = (action:string,values:Record<string,unknown>, recordCase?:string)=>Promise<boolean>;

const actionLabels:Record<ActionKind,string> = {
  confirmation:"Confirmation",profile:"Profile",documents:"Documents",agreements:"Agreements",payments:"Payments",appointments:"Appointments",
};
const taskStates = ["Open","In progress","Completed","Cancelled"];
const relationshipLabels = ["Spouse","Partner","Child","Parent","Other dependant"];

function useJourney<T>(caseId?:string,mode?:"overview"|"staff"){
  const params=new URLSearchParams();
  if(caseId)params.set("case",caseId);
  if(mode==="overview")params.set("overview","1");
  if(mode==="staff")params.set("audience","staff");
  const url="/api/client-journey?"+params.toString();
  const [data,setData]=useState<T|null>(null),[error,setError]=useState(""),[info,setInfo]=useState(""),[busy,setBusy]=useState(false);
  const load=useCallback(async(signal?:AbortSignal)=>{
    try{
      const result=await clientRequest<T>(url,undefined,signal);
      if(!signal?.aborted)setData(result);
    }catch(error){
      if(!signal?.aborted)setError((error as Error).message);
    }
  },[url]);
  useEffect(()=>{
    const controller=new AbortController();
    setData(null);setError("");setInfo("");
    void load(controller.signal);
    return ()=>controller.abort();
  },[load]);
  async function save(action:string,values:Record<string,unknown>,recordCase=caseId){
    if(!recordCase||busy)return false;
    setBusy(true);setError("");setInfo("");
    try{
      const result=await clientRequest<{message:string}>(url,{case:recordCase,action,...values});
      await load();
      setInfo(result.message);
      return true;
    }catch(error){setError((error as Error).message);return false;}
    finally{setBusy(false);}
  }
  return {url,data,error,info,busy,save,setError,refresh:()=>{setError("");void load();}};
}
function Message({error,info}:{error:string;info:string}){
  return <>{error&&<p className={styles.error} role="alert">{error} {error.includes("Confirm your password")&&<Link href="/customer/security">Open Security</Link>}</p>}
    {info&&<p className={styles.success} role="status">{info}</p>}</>;
}
function Panel({title,description,children}:{title:string;description?:string;children:ReactNode}){
  return <section className={styles.panel}><header><h2>{title}</h2>{description&&<p>{description}</p>}</header>{children}</section>;
}
function statusClass(state:string){
  if(state==="Complete"||state==="Completed"||state==="Published")return styles.complete;
  if(state==="Returned"||state==="Cancelled")return styles.cancelled;
  return styles.pending;
}
function Timeline({milestones,locale}:{milestones:Milestone[];locale:ClientLocale}){
  const next=milestones.find(item=>item.state==="In progress"&&item.next_action)
    ??milestones.find(item=>item.state!=="Complete"&&item.next_action)
    ??[...milestones].reverse().find(item=>item.next_action);
  return <Panel title={translateClient(locale,"journey")} description="Milestones approved by your case team.">
    {next&&<div className={styles.next}><strong>Next required action</strong><p>{next.next_action}</p></div>}
    {milestones.length===0?<ClientEmpty title="No milestones published yet" icon="project"><p>Your case team will publish dates and updates here.</p></ClientEmpty>
      :<ol className={styles.timeline}>{milestones.map(item=><li key={item.id}>
        <span className={styles.dot} aria-hidden="true" />
        <div className={styles.linehead}><strong>{item.stage_title}</strong><span className={statusClass(item.state)}>{item.state}</span></div>
        {item.event_on&&<time dateTime={item.event_on}>{dateLabel(item.event_on)}</time>}
        <p>{item.details}</p>
        {item.next_action&&item.id!==next?.id&&<p><strong>Next action </strong>{item.next_action}</p>}
      </li>)}</ol>}
  </Panel>;
}
function actionPath(action:Action){
  const args=action.caseId?"?case="+encodeURIComponent(action.caseId):"";
  return "/customer/"+action.kind+args;
}
function NextSteps({actions,busy,save,locale}:{actions:Action[];busy:boolean;save:Save;locale:ClientLocale}){
  return <Panel title={translateClient(locale,"actions")}>
    {actions.length===0?<ClientEmpty title="You’re up to date" icon="check"><p>New requests, payments and tasks will appear here.</p></ClientEmpty>
      :<ul className={styles.rows}>{actions.map(item=><li key={item.id}>
        <div><strong>{item.title}</strong>{item.details&&<p>{item.details}</p>}
          {(item.reference||item.dueOn)&&<small>{[item.reference,item.dueOn?"Due "+dateLabel(item.dueOn):null].filter(Boolean).join(" · ")}</small>}</div>
        {item.kind==="confirmation"
          ?<button type="button" className="btn btn-outline btn-small" disabled={busy} onClick={()=>void save("task-complete",{task:item.id,revision:item.revision},item.caseId)}>Mark complete</button>
          :<Link className="btn btn-outline btn-small" href={actionPath(item)}>Open {actionLabels[item.kind].toLowerCase()}</Link>}
      </li>)}</ul>}
  </Panel>;
}

function JourneyForm({action,busy,save,submitLabel,values,makeValues,onDone,children}:{action:string;busy:boolean;save:Save;submitLabel:string;values?:Record<string,unknown>;
  makeValues?:(form:FormData)=>Record<string,unknown>;onDone?:()=>void;children:ReactNode}){
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=event.currentTarget;
    const payload=new FormData(form);
    if(await save(action,{...values,...(makeValues?makeValues(payload):Object.fromEntries(payload))}))onDone?.();
  }
  return <form method="post" onSubmit={submit} className={styles.form}>
    <fieldset disabled={busy}>{children}</fieldset>
    <div className={styles.formButtons}><button className="btn btn-blue btn-small" disabled={busy}>{submitLabel}</button></div>
  </form>;
}
function FamilyFields({details}:{details?:FamilyDetails}){
  return <>
    <label>Full legal name<input name="name" autoComplete="off" maxLength={120} defaultValue={details?.name} required /></label>
    <label>Relationship<select name="relationship" defaultValue={details?.relationship??"Child"}>{relationshipLabels.map(item=><option key={item}>{item}</option>)}</select></label>
    <label>Birth date<input name="birthDate" type="date" min="1900-01-01" max={new Date().toISOString().slice(0,10)} defaultValue={details?.birthDate} required /></label>
    <label>Passport number<input name="passport" maxLength={30} defaultValue={details?.passport} autoComplete="off" spellCheck={false} /></label>
    <label>Passport issuing country<select name="passportCountry" defaultValue={details?.passportCountry??""}><option value="">Choose a country</option>
      {countries.map(item=><option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
    <label>Passport expiry<input name="passportExpiry" type="date" defaultValue={details?.passportExpiry} /></label>
  </>;
}
function FamilyPanel({data,save,busy,setError,url,staff=false,caseId}:{data:Family;save:Save;busy:boolean;setError:(value:string)=>void;url:string;staff?:boolean;caseId:string}){
  const [editor,setEditor]=useState<"new"|FamilyEdit|null>(null);
  const [loading,setLoading]=useState("");
  useEffect(()=>{
    const hide=()=>setEditor(null);
    function visibility(){if(document.hidden)hide();}
    window.addEventListener("pagehide",hide);window.addEventListener("beforeprint",hide);document.addEventListener("visibilitychange",visibility);
    return ()=>{window.removeEventListener("pagehide",hide);window.removeEventListener("beforeprint",hide);document.removeEventListener("visibilitychange",visibility);};
  },[]);
  async function open(member:string){
    setError("");setLoading(member);
    try{
      const result=await clientRequest<FamilyEdit>(url+"&dependant="+encodeURIComponent(member));
      if(!document.hidden&&document.hasFocus())setEditor(result);
    }catch(error){setError((error as Error).message);}
    finally{setLoading("");}
  }
  return <Panel title="Family and dependants" description="Manage family members included in this case and link their supporting documents.">
    {data.dependants.length===0&&<p className={styles.empty}>No family members have been added.</p>}
    <div className={styles.family}>{data.dependants.map(member=>{
      const choices=data.availableDocuments.filter(doc=>!member.documents.some(link=>link.id===doc.id));
      return <details key={member.id} className={styles.detail}><summary><strong>{member.name}</strong><small>{member.relationship} · {member.hasPassport?"Passport on file":"Passport not entered"}</small></summary>
        <div className={styles.inner}><button type="button" className="btn btn-outline btn-small" disabled={busy||Boolean(loading)} onClick={()=>void open(member.id)}>{loading===member.id?"Opening…":"View or edit private details"}</button>
          {editor&&editor!=="new"&&editor.id===member.id&&<>
            <JourneyForm action="family-edit" busy={busy} save={save} submitLabel="Save family details" onDone={()=>setEditor(null)} values={{dependant:member.id,revision:editor.revision}}>
              <FamilyFields details={editor.details}/>
            </JourneyForm><button type="button" className="btn btn-outline btn-small" onClick={()=>setEditor(null)}>Hide private details</button>
          </>}
          <div><h3>Supporting documents</h3>
            {member.documents.length>0&&<ul className={styles.rows}>{member.documents.map(doc=><li key={doc.id}>
              <div><strong>{doc.filename}</strong><p>{doc.category}</p></div>
              <button type="button" className="btn btn-outline btn-small" disabled={busy} onClick={()=>void save("family-unlink",{dependant:member.id,document:doc.id})}>Unlink</button>
            </li>)}</ul>}
            {choices.length>0?<JourneyForm action="family-link" busy={busy} save={save} submitLabel="Link document" values={{dependant:member.id}}>
              <label>Case document<select name="document" required defaultValue=""><option value="">Choose a document</option>
                {choices.map(doc=><option key={doc.id} value={doc.id}>{doc.filename} ({doc.category})</option>)}</select></label>
            </JourneyForm>:<p className={styles.empty}>{staff?"Only submitted case documents can be linked.":"Upload a supporting file in Documents, then return here to link it."}</p>}
            {!staff&&<Link href={"/customer/documents?case="+encodeURIComponent(caseId)}>Open case documents</Link>}
          </div>
          <details className={styles.archive}><summary>Archive family member</summary>
            <p>The family member will be taken off this list. Case records and original documents are retained.</p>
            <button type="button" className="btn btn-outline btn-small" disabled={busy} onClick={()=>void save("family-archive",{dependant:member.id,revision:member.revision})}>Confirm archive</button>
          </details>
        </div>
      </details>;
    })}</div>
    {editor==="new"?<div className={styles.inner}>
      <JourneyForm action="family-add" busy={busy} save={save} submitLabel="Add family member" onDone={()=>setEditor(null)}><FamilyFields/></JourneyForm>
      <button type="button" className="btn btn-outline btn-small" onClick={()=>setEditor(null)}>Cancel</button>
    </div>:<button type="button" className="btn btn-outline btn-small" onClick={()=>setEditor("new")}>Add family member</button>}
  </Panel>;
}

export function ClientJourney({caseId,mode,locale="en"}:{caseId?:string;mode?:"overview";locale?:ClientLocale}){
  const journey=useJourney<Journey>(caseId,mode);
  return <div className={styles.stack} aria-busy={!journey.data&&!journey.error}>
    <Message error={journey.error} info={journey.info}/>
    {!journey.data?(journey.error?<button type="button" className="btn btn-outline btn-small" onClick={journey.refresh}>Retry case journey</button>
      :<p className={styles.empty} role="status">Loading your case journey…</p>):<>
      <NextSteps actions={journey.data.actions} save={journey.save} busy={journey.busy} locale={locale}/>
      {caseId&&<Timeline milestones={journey.data.milestones} locale={locale}/>}
      {caseId&&journey.data.family&&<FamilyPanel key={caseId} data={journey.data.family} save={journey.save} busy={journey.busy} setError={journey.setError} url={journey.url} caseId={caseId}/>}
    </>}
  </div>;
}

function StageForm({stage,busy,save}:{stage?:Stage;busy:boolean;save:Save}){
  return <JourneyForm action={stage?"stage-edit":"stage-create"} busy={busy} save={save} submitLabel={stage?"Save changes":"Create stage"}
    makeValues={form=>({...Object.fromEntries(form),enabled:form.has("enabled"),...(stage?{stage:stage.id,revision:stage.revision}:{})})}>
    <label>Stage name<input name="title" defaultValue={stage?.title} maxLength={100} required /></label>
    <label>Timeline order<input name="position" type="number" min={1} max={9999} defaultValue={stage?.position??100} required /></label>
    <label className={styles.full}>Team guidance<textarea name="description" defaultValue={stage?.description} maxLength={500} rows={2}/></label>
    <label className={styles.check}><input name="enabled" type="checkbox" defaultChecked={stage?.enabled??true} /> Available for new milestones</label>
  </JourneyForm>;
}
function TaskForm({task,busy,save}:{task?:Task;busy:boolean;save:Save}){
  return <JourneyForm action={task?"task-edit":"task-create"} busy={busy} save={save} submitLabel={task?"Save task changes":"Assign to client"}
    values={task?{task:task.id,revision:task.revision}:undefined}>
    <label className={styles.full}>Client-facing task title<input name="title" defaultValue={task?.title} maxLength={140} required /></label>
    <label className={styles.full}>Instructions<textarea name="details" defaultValue={task?.details} maxLength={1500} rows={3} /></label>
    <label>Action<select name="kind" defaultValue={task?.action_kind??"confirmation"}>{Object.entries(actionLabels).map(([key,value])=><option key={key} value={key}>{value}</option>)}</select></label>
    <label>Due date<input type="date" name="dueOn" defaultValue={task?.due_on??""}/></label>
    <label>Status<select name="status" defaultValue={task?.status??"Open"}>{taskStates.map(item=><option key={item}>{item}</option>)}</select></label>
  </JourneyForm>;
}

export function StaffClientJourney({caseId}:{caseId:string}){
  const journey=useJourney<Casework>(caseId,"staff");
  const {data,save,busy,error,info}=journey;
  const [selected,setSelected]=useState("");
  const stage=data?.stages.find(item=>item.id===selected&&item.enabled)??data?.stages.find(item=>item.enabled);
  return <div className={styles.stack} aria-busy={!data&&!error}>
    <Message error={error} info={info}/>
    {!data?(error?<button type="button" className="btn btn-outline btn-small" onClick={journey.refresh}>Retry case journey</button>
      :<p className={styles.empty} role="status">Loading case journey…</p>):<>
      <Panel title="Immigration journey" description="Submit dates and updates for independent review before sharing them with the client.">
        {data.stages.some(item=>item.enabled)?<details className={styles.detail}><summary><strong>Propose a milestone</strong></summary>
          <JourneyForm action="milestone-submit" busy={busy} save={save} submitLabel="Send for review">
            <label>Stage<select name="stage" value={stage?.id??""} onChange={event=>setSelected(event.currentTarget.value)} required>
              {data.stages.filter(item=>item.enabled).map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
            <label>Status<select name="state" defaultValue="In progress">{["Upcoming","In progress","Complete"].map(item=><option key={item}>{item}</option>)}</select></label>
            {stage?.description&&<p className={styles.full}>{stage.description}</p>}
            <label>Milestone date<input name="eventOn" type="date"/></label>
            <label className={styles.full}>Client-facing description<textarea name="details" maxLength={2000} rows={3} required/></label>
            <label className={styles.full}>Next required action<textarea name="nextAction" maxLength={500} rows={2}/></label>
          </JourneyForm>
        </details>:<p className={styles.empty}>No stages are available. A Super Admin can enable them below.</p>}
        {data.milestones.length>0&&<ul className={styles.rows}>{data.milestones.map(item=><li key={item.id}>
          <div><div className={styles.linehead}><strong>{item.stage_title} · {item.state}</strong><span className={statusClass(item.decision)}>{item.decision}</span></div>
            <p>{item.details}</p>{item.next_action&&<p><strong>Next action </strong>{item.next_action}</p>}
            <small>{item.event_on?dateLabel(item.event_on):"No milestone date"}</small>
            {item.review_note&&<p><strong>Internal review note </strong>{item.review_note}</p>}
            {item.decision==="Pending"&&data.canReview&&item.submitted_by!==data.staffId&&<JourneyForm action="milestone-review" busy={busy} save={save} submitLabel="Record decision" values={{milestone:item.id}}>
              <label>Decision<select name="decision" defaultValue="Published"><option value="Published">Publish to client</option><option value="Returned">Return to staff</option></select></label>
              <label>Internal review note<input name="note" maxLength={500}/></label>
            </JourneyForm>}
          </div>
        </li>)}</ul>}
        {data.canConfigure&&<details className={styles.detail}><summary><strong>Manage workflow stages</strong></summary>
          <div className={styles.inner}><StageForm save={save} busy={busy}/>
            {data.stages.map(item=><details key={item.id+":"+item.revision} className={styles.detail}>
              <summary><strong>{item.title}</strong><small>Order {item.position} · {item.enabled?"Available":"Inactive"}</small></summary>
              <StageForm stage={item} busy={busy} save={save}/>
            </details>)}
          </div>
        </details>}
      </Panel>
      <Panel title="Client action tasks" description="Assign or update the steps shown in Your Next Steps.">
        <details className={styles.detail}><summary><strong>Assign a client task</strong></summary><TaskForm busy={busy} save={save}/></details>
        {data.tasks.length===0&&<p className={styles.empty}>There are no assigned client tasks for this case.</p>}
        {data.tasks.map(task=><details className={styles.detail} key={task.id+":"+task.revision}>
          <summary><strong>{task.title}</strong><small>{task.status}{task.due_on?" · Due "+dateLabel(task.due_on):""}</small></summary>
          <TaskForm task={task} busy={busy} save={save}/>
        </details>)}
      </Panel>
      <FamilyPanel key={caseId} data={data.family} save={save} busy={busy} setError={journey.setError} url={journey.url} caseId={caseId} staff/>
    </>}
  </div>;
}
