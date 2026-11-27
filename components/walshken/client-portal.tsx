"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { countries, countryName } from "@/lib/walshken/catalog";
import { clientNavigation, type ClientSection } from "@/lib/walshken/client-feature";
import { clientLocaleNames, translateClient, type ClientLocale, type ClientText } from "@/lib/walshken/client-locales";
import { ClientJourney } from "./client-journey";
import { ClientAppointments, ClientAppointmentSummary } from "./client-appointments";
import { ClientConversation } from "./client-conversations";
import { ClientFeedback } from "./client-feedback";
import { Brand, Icon } from "./brand";
import { clientRequest } from "./client-access";
import { ClientAccount, ClientAlerts, ClientSecurity } from "./client-account";
import { ClientDocuments } from "./client-documents";
import { ClientFinance } from "./client-finance";
import { ClientCalls } from "./client-calls";
import { ClientEmpty, caseLink, dateLabel, type ClientCase } from "./client-ui";

type CaseDetails = {
  case:ClientCase;
  updates:{id:string;title:string;body:string;proposed_status:string|null;submission_date:string|null;published_at:string}[];
  requests:{id:string;title:string;instructions:string;due_on:string|null;status:string;created_at:string}[];
};
type Status = {verified:boolean;email:string;sessionId:string};
type Alert = {id:string;type:string;title:string;body:string;href:string;createdAt:string;readAt:string|null};
type Finance = {outstandingInvoices:number;pendingAgreements:number;balances:{currency:string;amount_minor:string;invoices:number}[]};
type UploadedDocument = {id:string;filename:string;review_status:string;submitted_at:string;deleted_at:string|null};
function CaseBadge({status}:{status:string}) {
  return <span className={`client-badge ${["Complete","Submitted","Decision available"].includes(status)?"is-success":status==="Action required"?"is-warning":""}`}>{status}</span>;
}
function Representative({item}:{item:ClientCase}) {
  return <div className="client-representative"><span className="client-symbol"><Icon name="user"/></span><div>
    <strong>{item.representative_name??"Assignment pending"}</strong>
    <span>{item.representative_designation??(item.representative_name?"Your Walshken representative":"Walshken will assign your representative.")}</span>
  </div></div>;
}
function CaseRequests({details}:{details:CaseDetails}) {
  return <section className="client-card"><div className="client-card-heading"><div><h2>Document requests</h2><p>Check each requirement and its review status.</p></div><Link href={caseLink("documents",details.case.id)} className="client-text">Open documents <Icon name="right" size={16}/></Link></div>
    {details.requests.length?<ul className="client-list">{details.requests.map(item=><li key={item.id}><div><strong>{item.title}</strong>{item.instructions&&<p>{item.instructions}</p>}<small>{item.due_on?`Due ${dateLabel(item.due_on)}`:"No deadline set"}</small></div><CaseBadge status={item.status}/></li>)}</ul>:<ClientEmpty icon="file" title="No document requests"><p>Your representative can request documents for this case.</p></ClientEmpty>}
  </section>;
}
function CaseSummary({details}:{details:CaseDetails}) {
  const item=details.case;
  return <>
    <section className="client-card client-case-summary"><div className="client-card-heading"><div><p className="client-eyebrow">{item.reference}</p><h2>{item.title}</h2><p>{item.service} · {countryName(item.country)}</p></div><CaseBadge status={item.client_status}/></div>
      <dl className="client-meta"><div><dt>Request received</dt><dd>{dateLabel(item.submitted_at??item.created_at)}</dd></div><div><dt>Application submitted</dt><dd>{dateLabel(item.application_submitted_on)||"Awaiting confirmation"}</dd></div></dl>
      <Representative item={item}/>
    </section>
    <CaseRequests details={details}/>
    <section className="client-card"><div className="client-card-heading"><div><h2>Case activity</h2><p>Progress updates from your Walshken team.</p></div></div>
      {details.updates.length?<ol className="client-timeline">{details.updates.map(item=><li key={item.id}><div><h3>{item.title}</h3>{item.proposed_status&&<CaseBadge status={item.proposed_status}/>}</div><p>{item.body}</p><small>{dateLabel(item.published_at)}</small></li>)}</ol>:<ClientEmpty icon="history" title="Case received"><p>Published progress updates will appear here.</p></ClientEmpty>}
    </section>
  </>;
}

function NewCase({done,cancel}:{done:(id:string)=>void;cancel:()=>void}){
  const [error,setError]=useState(""),[busy,setBusy]=useState(false);
  const attempt=useRef<string|null>(null);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setBusy(true);setError("");
    attempt.current??=crypto.randomUUID();
    try{const result=await clientRequest<{id:string}>("/api/client-cases",{...Object.fromEntries(new FormData(event.currentTarget)),action:"submit",requestId:attempt.current});done(result.id);}
    catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }
  return <section className="client-card"><div className="client-card-heading"><div><h2>Start a new case</h2><p>Tell your Walshken team the immigration service you need.</p></div></div>
    <form method="post" className="client-form client-form-grid" onSubmit={submit}>
      <label>Case title<input name="title" maxLength={160} required/></label>
      <label>Destination country<select name="country" required defaultValue=""><option value="" disabled>Select a country or territory</option>{countries.map(item=><option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
      <label className="client-full">Service or application type<input name="service" maxLength={150} placeholder="For example, study permit" required/></label>
      <label className="client-full">Anything we should know? <span className="client-field-note">Optional</span><textarea name="message" rows={4} maxLength={5000}/></label>
      {error&&<p className="client-alert client-full" role="alert">{error}</p>}
      <div className="client-form-actions client-full"><button className="btn btn-blue" disabled={busy}>{busy?"Submitting…":"Submit case"}</button><button className="client-text" type="button" onClick={cancel}>Cancel</button></div>
    </form>
  </section>;
}

export function ClientPortal({section,person,initialCase,appointmentId}:{section:ClientSection;person:{name:string;email:string};initialCase?:string;appointmentId?:string}){
  const [status,setStatus]=useState<Status>(),[cases,setCases]=useState<ClientCase[]>(),[details,setDetails]=useState<CaseDetails>(),[alerts,setAlerts]=useState<Alert[]>([]);
  const [finance,setFinance]=useState<Finance>(),[documents,setDocuments]=useState<{caseId:string;items:UploadedDocument[]}>();
  const [selected,setSelected]=useState(initialCase??""),[error,setError]=useState(""),[listError,setListError]=useState(""),[caseError,setCaseError]=useState("");
  const [mobile,setMobile]=useState(false),[revision,reload]=useState(0),[newCase,setNewCase]=useState(false),[masked,setMasked]=useState(false);
  const [checkingPrivacy,setCheckingPrivacy]=useState(false),[privacyError,setPrivacyError]=useState("");
  const [language,setLanguage]=useState<{locale:ClientLocale;enabled:ClientLocale[]}>({locale:"en",enabled:["en"]});
  const [changingLanguage,setChangingLanguage]=useState(false);
  const t=(key:ClientText,values?:Record<string,string>)=>translateClient(language.locale,key,values);
  const refresh=useCallback(()=>reload(value=>value+1),[]);
  const selectedCase=selected||cases?.[0]?.id;
  const sensitive=["documents","contact","payments","agreements","profile","security","appointments","support"].includes(section);
  useEffect(()=>{
    setSelected(initialCase??"");
    setMobile(false);setNewCase(false);
  },[section,initialCase]);
  useEffect(()=>{
    const ctl=new AbortController();
    clientRequest<Status>("/api/customer/status",undefined,ctl.signal).then(setStatus).catch(e=>{
      if(ctl.signal.aborted)return;
      if(e.status===401){window.location.assign("/customer/sign-in");return;}
      setError(e.message);
    });
    return ()=>ctl.abort();
  },[revision]);
  useEffect(()=>{
    if(!status?.verified)return;
    const ctl=new AbortController();
    clientRequest<{cases:ClientCase[]}>("/api/client-cases",undefined,ctl.signal).then(result=>{setCases(result.cases);setListError("");}).catch(e=>{if(!ctl.signal.aborted)setListError(e.message);});
    const loadAlerts=()=>{void clientRequest<{notifications:Alert[]}>("/api/customer/notifications",undefined,ctl.signal).then(result=>setAlerts(result.notifications)).catch(()=>{});};
    loadAlerts();
    const timer=window.setInterval(()=>{if(!document.hidden)loadAlerts();},35_000);
    return ()=>{ctl.abort();window.clearInterval(timer);};
  },[status?.verified,revision]);
  useEffect(()=>{
    if(!status?.verified)return;
    const controller=new AbortController();
    void clientRequest<{locale:ClientLocale;enabled:ClientLocale[]}>("/api/customer/locale",undefined,controller.signal)
      .then(setLanguage).catch(()=>{});
    return ()=>controller.abort();
  },[status?.verified]);
  useEffect(()=>{
    if(!status?.verified)return;
    const controller=new AbortController();
    let last=Date.now();
    const onActivity=()=>{
      if(document.hidden||Date.now()-last<90_000)return;
      last=Date.now();
      void clientRequest<Status>("/api/customer/activity",{},controller.signal).catch(e=>{if(e.status===401)window.location.assign("/customer/sign-in");});
    };
    const checkStatus=()=>{
      if(document.hidden)return;
      void clientRequest<Status>("/api/customer/status",undefined,controller.signal).catch(e=>{if(e.status===401)window.location.assign("/customer/sign-in");});
    };
    window.addEventListener("pointerdown",onActivity);
    window.addEventListener("keydown",onActivity);
    window.addEventListener("focus",checkStatus);
    const timer=window.setInterval(checkStatus,60_000);
    return ()=>{window.removeEventListener("pointerdown",onActivity);window.removeEventListener("keydown",onActivity);window.removeEventListener("focus",checkStatus);window.clearInterval(timer);controller.abort();};
  },[status?.verified]);
  useEffect(()=>{
    if(section!=="overview"||!status?.verified)return;
    const controller=new AbortController();
    void clientRequest<Finance>("/api/client-finance?summary=1",undefined,controller.signal).then(setFinance).catch(()=>{});
    if(selectedCase)void clientRequest<{documents:UploadedDocument[]}>("/api/client-documents/list?case="+encodeURIComponent(selectedCase),undefined,controller.signal)
      .then(value=>setDocuments({caseId:selectedCase,items:value.documents.filter(item=>!item.deleted_at).slice(0,4)})).catch(()=>{});
    return ()=>controller.abort();
  },[section,status?.verified,selectedCase,revision]);
  useEffect(()=>{
    if(!status?.verified||!selectedCase||!["overview","cases","documents","contact"].includes(section))return;
    const ctl=new AbortController();
    setCaseError("");
    const fetchCase=()=>{void clientRequest<CaseDetails>("/api/client-cases?case="+encodeURIComponent(selectedCase),undefined,ctl.signal)
      .then(setDetails).catch(e=>{if(!ctl.signal.aborted)setCaseError(e.message);});};
    fetchCase();
    return ()=>ctl.abort();
  },[status?.verified,selectedCase,section,revision]);
  useEffect(()=>{
    if(!sensitive)return;
    function obscure(){setMasked(true);}
    function visibility(){if(document.hidden)obscure();}
    window.addEventListener("blur",obscure);
    document.addEventListener("visibilitychange",visibility);
    window.addEventListener("beforeprint",obscure);
    return ()=>{window.removeEventListener("blur",obscure);document.removeEventListener("visibilitychange",visibility);window.removeEventListener("beforeprint",obscure);setMasked(false);};
  },[sensitive]);
  useEffect(()=>{
    if(!mobile)return;
    function key(event:KeyboardEvent){if(event.key==="Escape")setMobile(false);}
    window.addEventListener("keydown",key);
    return ()=>window.removeEventListener("keydown",key);
  },[mobile]);
  async function signOut(){
    try{await clientRequest("/api/customer/sign-out",{});window.location.assign("/customer/sign-in");}
    catch(e){setError((e as Error).message);}
  }
  async function reveal(){
    setCheckingPrivacy(true);setPrivacyError("");
    try {
      const current=await clientRequest<Status>("/api/customer/status");
      setStatus(current);
      if(!current.verified)return;
      setMasked(false);
    } catch(e) {
      if((e as {status?:number}).status===401){window.location.assign("/customer/sign-in");return;}
      setPrivacyError((e as Error).message);
    } finally { setCheckingPrivacy(false); }
  }
  async function chooseLanguage(locale:ClientLocale){
    setChangingLanguage(true);
    try{setLanguage(await clientRequest<{locale:ClientLocale;enabled:ClientLocale[]}>("/api/customer/locale",{locale}));setError("");}
    catch(e){setError((e as Error).message);}finally{setChangingLanguage(false);}
  }
  function choose(id:string){setSelected(id);window.history.replaceState(null,"",caseLink(section,id));}
  const navItem=clientNavigation.find(item=>item[0]===section)!;
  const active=details?.case.id===selectedCase?details:undefined;
  const unread=alerts.filter(item=>!item.readAt).length;
  const heading=section==="overview"?t("welcome",{name:person.name.split(" ")[0]}):t(navItem[0]);
  return <div className="client-shell" lang={language.locale} dir={language.locale==="ur"?"rtl":"ltr"}>
    <a className="client-skip" href="#client-content">{t("skip")}</a>
    {mobile&&<button type="button" className="client-scrim" aria-label={t("closeMenu")} onClick={()=>setMobile(false)}/>}
    <aside id="client-navigation" className={`client-sidebar${mobile?" is-open":""}`}><Brand href="/customer"/><p className="client-sidebar-label">{t("portal")}</p>
      <nav aria-label={t("portal")}>{clientNavigation.map(([key,,icon])=><Link key={key} href={caseLink(key)} aria-current={section===key?"page":undefined} onClick={()=>setMobile(false)}><Icon name={icon} size={19}/><span>{t(key)}</span>{key==="notifications"&&unread>0&&<span className="client-nav-count">{unread}</span>}</Link>)}</nav>
      <div className="client-sidebar-bottom"><Link href="/"><Icon name="external" size={16}/> {t("site")}</Link><button type="button" onClick={()=>void signOut()}><Icon name="logout" size={17}/> {t("signOut")}</button></div>
    </aside>
    <div className="client-work"><header className="client-top"><button className="client-mobile-toggle" type="button" onClick={()=>setMobile(!mobile)} aria-label={mobile?t("closeMenu"):t("openMenu")} aria-expanded={mobile} aria-controls="client-navigation"><Icon name={mobile?"close":"menu"}/></button>
      <span className="client-crumb">{t("portal")} <Icon name="next" size={15}/> <strong>{t(navItem[0])}</strong></span>
      <div className="client-top-tools">{status?.verified&&language.enabled.length>1&&<label className="client-language"><Icon name="globe" size={16}/><select aria-label={t("language")} value={language.locale} disabled={changingLanguage} onChange={e=>void chooseLanguage(e.target.value as ClientLocale)}>{language.enabled.map(locale=><option key={locale} value={locale} lang={locale}>{clientLocaleNames[locale]}</option>)}</select></label>}<Link aria-label={`Notifications${unread?` (${unread} unread)`:""}`} href="/customer/notifications"><Icon name="bell"/>{unread>0&&<i/>}</Link><Link href="/customer/profile" className="client-avatar" aria-label="My profile">{person.name.split(/\s+/).slice(0,2).map(value=>value[0]).join("").toUpperCase()}</Link></div>
    </header>
    <main className="client-main" id="client-content">
      <div className="client-page-heading"><div><h1>{heading}</h1><p>{t(section+"Intro" as ClientText)}</p></div>{(section==="cases"||section==="overview")&&status?.verified&&!newCase&&<button className="btn btn-blue" onClick={()=>setNewCase(true)}><Icon name="plus" size={17}/> {t("startCase")}</button>}</div>
      {error&&<p className="client-alert" role="alert">{error} <button className="client-text" onClick={refresh}>Retry</button></p>}
      {!status&&!error&&<p className="client-loading" role="status">{t("loading")}</p>}
      {status&&!status.verified&&<VerifyExisting email={status.email} done={refresh}/>}
      {status?.verified&&<><div className={`client-sensitive${masked?" is-masked":""}`} inert={masked}>
      {(section==="overview"||section==="cases")&&newCase&&<NewCase cancel={()=>setNewCase(false)} done={id=>{setNewCase(false);if(section==="overview"){window.location.assign(caseLink("cases",id));return;}choose(id);refresh();}}/>}
      {["overview","cases","documents","contact"].includes(section)&&listError&&<p className="client-alert" role="alert">{listError} <button className="client-text" onClick={refresh}>Retry</button></p>}
      {["overview","cases","documents","contact"].includes(section)&&!listError&&cases===undefined&&<p className="client-loading" role="status">Loading your cases…</p>}
      {["cases","documents","contact"].includes(section)&&cases?.length===0&&!newCase&&<section className="client-card"><ClientEmpty icon="project" title="You have no cases yet"><p>Start a case to track an application, submit documents and contact your representative.</p>{section==="cases"?<button type="button" className="client-text" onClick={()=>setNewCase(true)}>Start a case <Icon name="right" size={16}/></button>:<Link className="client-text" href="/customer/cases">Go to my cases <Icon name="right" size={16}/></Link>}</ClientEmpty></section>}
      {["cases","documents","contact","appointments","support"].includes(section)&&Boolean(cases?.length)&&<div className="client-case-picker"><label htmlFor="client-case-select">{t("chooseCase")}</label><select id="client-case-select" value={selectedCase} onChange={e=>choose(e.target.value)}>{selected&&!cases?.some(item=>item.id===selected)&&<option value={selected}>Selected case</option>}{cases?.map(item=><option key={item.id} value={item.id}>{item.title} · {item.reference}</option>)}</select></div>}
      {caseError&&<p className="client-alert" role="alert">{caseError} <button className="client-text" onClick={refresh}>Retry</button></p>}
      {section==="cases"&&active&&<><ClientJourney caseId={active.case.id} locale={language.locale}/><CaseSummary details={active}/></>}
      {section==="cases"&&<p><Link className="client-text" href="/customer?legacy=1">View earlier website inquiries <Icon name="external" size={15}/></Link></p>}
      {section==="documents"&&active&&<ClientDocuments key={active.case.id} caseId={active.case.id}/>}
      {section==="contact"&&active&&<><ClientCalls audience="client" caseId={active.case.id}/><ClientConversation key={active.case.id} caseId={active.case.id}/></>}
      {(section==="payments"||section==="agreements")&&<ClientFinance section={section}/>}
      {section==="notifications"&&<ClientAccountAlerts reload={refresh}/>}
      {section==="profile"&&<ClientAccount/>}
      {section==="appointments"&&(selectedCase?<ClientAppointments caseId={selectedCase} appointmentId={appointmentId}/>:cases&&<section className="client-card"><ClientEmpty title="Start a case before booking" icon="calendar"><Link className="client-text" href="/customer/cases">Open My cases</Link></ClientEmpty></section>)}
      {section==="support"&&<ClientFeedback caseId={selectedCase} cases={cases??[]}/>}
      {section==="security"&&<ClientSecurity cases={cases??[]} person={person}/>}
      {section==="overview"&&<><ClientJourney caseId={selectedCase} mode="overview" locale={language.locale}/>{selectedCase&&<ClientAppointmentSummary caseId={selectedCase}/>}<div className="client-overview-grid"><section className="client-card">
        <div className="client-card-heading"><div><h2>{t("caseOverview")}</h2><p>Your latest application activity.</p></div><Link href="/customer/cases" className="client-text">My cases <Icon name="right" size={16}/></Link></div>
        {cases?.length?<ul className="client-list">{cases.slice(0,4).map(item=><li key={item.id}><div><Link href={caseLink("cases",item.id)}><strong>{item.title}</strong></Link><p>{item.reference} · {countryName(item.country)}</p></div><CaseBadge status={item.client_status}/></li>)}</ul>:<ClientEmpty icon="project" title="Case list empty"/>}
        {active&&<Representative item={active.case}/>}
      </section><section className="client-card"><div className="client-card-heading"><div><h2>{t("recentNotifications")}</h2><p>Updates that may need your attention.</p></div></div>
      {alerts.length?<ul className="client-list">{alerts.slice(0,4).map(item=><li key={item.id}><div><Link href={item.href}><strong>{item.title}</strong></Link><p>{item.body}</p></div></li>)}</ul>:<ClientEmpty title={t("noUpdates")} icon="bell"/>}
      <Link href="/customer/notifications" className="client-text">{t("allNotifications")} <Icon name="right" size={16}/></Link>
      </section></div>{active&&<CaseRequests details={active}/>}
      {(finance||documents?.caseId===selectedCase)&&<div className="client-overview-grid">
        {documents&&documents.caseId===selectedCase&&<section className="client-card"><div className="client-card-heading"><div><h2>{t("recentUploads")}</h2><p>Documents received for your latest case.</p></div><Link className="client-text" href={caseLink("documents",selectedCase)}>Documents <Icon name="right" size={16}/></Link></div>
        {documents.items.length?<ul className="client-list">{documents.items.map(item=><li key={item.id}><div><strong>{item.filename}</strong><p>{dateLabel(item.submitted_at)}</p></div><CaseBadge status={item.review_status}/></li>)}</ul>:<ClientEmpty icon="file" title="No documents uploaded"/>}</section>}
        {finance&&<section className="client-card"><div className="client-card-heading"><div><h2>{t("billing")}</h2><p>{finance.outstandingInvoices} outstanding {finance.outstandingInvoices===1?"invoice":"invoices"}</p></div><Link className="client-text" href="/customer/payments">Payments <Icon name="right" size={16}/></Link></div>
        {finance.balances.length>0&&<ul className="client-list">{finance.balances.map(item=><li key={item.currency}><strong>{new Intl.NumberFormat(undefined,{style:"currency",currency:item.currency,currencyDisplay:"code"}).format(Number(item.amount_minor)/100)}</strong></li>)}</ul>}
        <Link className="client-text" href="/customer/agreements">{finance.pendingAgreements} awaiting signature <Icon name="right" size={16}/></Link></section>}
      </div>}
      <section className="client-quick-links" aria-label="Quick access">{(["documents","contact","payments"] as const).map(key=>{const item=clientNavigation.find(row=>row[0]===key)!;return <Link key={key} href={caseLink(key,selectedCase)}><span className="client-symbol"><Icon name={item[2]}/></span><strong>{t(item[0])}</strong><Icon name="right" size={17}/></Link>;})}</section></>}
      </div>{masked&&<div className="client-mask"><div role="status"><span className="client-symbol"><Icon name="lock"/></span><h2>Private view hidden</h2><p>Continue to view your sensitive information.</p>{privacyError&&<p className="client-alert" role="alert">{privacyError}</p>}<button className="btn btn-blue" disabled={checkingPrivacy} onClick={()=>void reveal()}>{checkingPrivacy?"Checking session…":"Continue"}</button></div></div>}</>}
    </main></div>
  </div>;
}
function ClientAccountAlerts({reload}:{reload:()=>void}){return <ClientAlerts onChanged={reload}/>;}

function VerifyExisting({email,done}:{email:string;done:()=>void}){
  const [challenge,setChallenge]=useState(""),[notice,setNotice]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  async function request(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setBusy(true);setNotice("");setError("");
    const data=Object.fromEntries(new FormData(event.currentTarget));
    try{
      if(challenge){await clientRequest("/api/customer/verify",{challengeId:challenge,code:data.code});done();}
      else {const res=await clientRequest<{challengeId:string;message:string}>("/api/customer/verification",{});setChallenge(res.challengeId);setNotice(res.message);}
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <section className="client-card"><div className="client-card-heading"><div><h2>Verify your email to continue</h2><p>A one-time code will be sent to {email}.</p></div></div><form method="post" className="client-form" onSubmit={request}>
    {challenge&&<label>One-time code<input name="code" autoComplete="one-time-code" inputMode="numeric" maxLength={6} pattern="[0-9]{6}" required/></label>}
    {notice&&<p role="status" className="client-success">{notice}</p>}{error&&<p className="client-alert" role="alert">{error}</p>}
    <div className="client-form-actions"><button className="btn btn-blue" disabled={busy}>{busy?"Please wait…":challenge?"Verify email":"Send the code"}</button>{challenge&&<button type="button" className="client-text" onClick={()=>setChallenge("")}>Request a new code</button>}</div>
  </form></section>;
}
