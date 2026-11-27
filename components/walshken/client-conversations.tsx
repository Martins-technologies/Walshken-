"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "./brand";
import { SecureDocumentViewer } from "./client-documents";
import styles from "./client-communication.module.css";

type Audience="client"|"staff";
type Message={id:string;direction:"Client"|"Company";display_name:string;body:string;created_at:string;viewer_read_at:string|null;recipient_read_at:string|null;version_id:string|null;filename:string|null;version:number|null;page_count:number|null;document_id:string|null;attachment_unavailable:boolean};
type Channel={endpoint:string;name:string;kind:string;available:boolean;unread:number};
type Thread={messages:Message[];before:string|null;unread:number;threads:Channel[];writable:boolean;endpoint:string;label:string};
type CaseFile={id:string;current_version_id:string;filename:string;version:number;page_count:number;deleted_at:string|null;disposal_status:string|null};
type InboxItem={case_id:string;reference:string;client_name:string;endpoint_id:string;office_name:string;latest_at:string;unread:number};

export function communicationDate(stamp:string) {
  if(!stamp)return "";
  const date=new Date(stamp);
  return Number.isNaN(date.getTime())?"":date.toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"});
}

export async function communicationRequest<T>(url:string,data?:Record<string,unknown>,signal?:AbortSignal):Promise<T>{
  const response=await fetch(url,{cache:"no-store",signal,...(data?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)}:{})});
  const result=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(result?.error||"Walshken could not complete the request.");
  return result as T;
}

function ReadStatus({stamp}:{stamp:string|null}){
  return <span className={styles.receipt} title={stamp?communicationDate(stamp):undefined}>
    <Icon name="check" size={13}/>{stamp?"Read":"Sent"}
  </span>;
}

function Conversation({caseId,audience,initialEndpoint=""}:{caseId:string;audience:Audience;initialEndpoint?:string}){
  const route="/api/client-conversations/"+audience;
  const [endpoint,setEndpoint]=useState(initialEndpoint),[thread,setThread]=useState<Thread|null>(null),[older,setOlder]=useState<Message[]>([]);
  const [pastCursor,setPastCursor]=useState<string|null>(null),[loadedOlder,setLoadedOlder]=useState(false);
  const [body,setBody]=useState(""),[attachment,setAttachment]=useState<CaseFile|null>(null),[files,setFiles]=useState<CaseFile[]|null>(null);
  const [preview,setPreview]=useState<Message|null>(null),[showFiles,setShowFiles]=useState(false),[finding,setFinding]=useState(false);
  const [error,setError]=useState(""),[sending,setSending]=useState(false),[loadingOlder,setLoadingOlder]=useState(false);
  const settled=useRef(new Set<string>()),scrollBox=useRef<HTMLDivElement>(null),submission=useRef<string|null>(null),scopeKey=useRef("");
  const url=useCallback((before?:string)=>{
    const params=new URLSearchParams({case:caseId});
    if(endpoint)params.set("endpoint",endpoint);
    if(before)params.set("before",before);
    return route+"?"+params.toString();
  },[caseId,endpoint,route]);
  const own=audience==="client"?"Client":"Company";
  const scope=caseId+"|"+endpoint;
  scopeKey.current=scope;

  useEffect(()=>{
    if(audience==="client")setEndpoint(new URLSearchParams(window.location.search).get("thread")??"");
  },[audience,caseId]);

  const refresh=useCallback(async(signal?:AbortSignal)=>{
    const target=scope;
    try{
      const next=await communicationRequest<Thread>(url(),undefined,signal);
      if(!signal?.aborted&&scopeKey.current===target){setThread(next);setError("");}
    }catch(reason){
      if(!signal?.aborted&&scopeKey.current===target){setThread(null);setError((reason as Error).message);}
    }
  },[scope,url]);

  useEffect(()=>{
    const controller=new AbortController();
    setThread(null);setOlder([]);setPastCursor(null);setLoadedOlder(false);setError("");
    setPreview(null);setAttachment(null);setShowFiles(false);setFiles(null);setBody("");
    submission.current=null;settled.current.clear();
    const visibleRefresh=()=>{if(!document.hidden)void refresh(controller.signal);};
    visibleRefresh();
    document.addEventListener("visibilitychange",visibleRefresh);
    const timer=window.setInterval(visibleRefresh,9_000);
    return()=>{controller.abort();document.removeEventListener("visibilitychange",visibleRefresh);window.clearInterval(timer);};
  },[refresh]);

  useEffect(()=>{
    const viewport=scrollBox.current;
    if(!viewport||!thread||loadedOlder)return;
    viewport.scrollTop=viewport.scrollHeight;
  },[thread?.messages.at(-1)?.id,loadedOlder]);

  const displayed=thread?[...older.filter(item=>!thread.messages.some(current=>item.id===current.id)),...thread.messages]:[];
  const unreadKey=displayed.filter(item=>item.direction!==own&&!item.viewer_read_at).map(item=>item.id).join(",");
  useEffect(()=>{
    const viewport=scrollBox.current;
    if(!viewport||!unreadKey)return;
    const eligible=new Set(unreadKey.split(","));
    const queued=new Set<string>();
    let timer:number|undefined;
    const controller=new AbortController();
    async function flush(){
      const messages=[...queued].slice(0,50);
      queued.clear();
      if(document.hidden||!document.hasFocus()||!messages.length)return;
      for(const key of messages)settled.current.add(key);
      try{
        const result=await communicationRequest<{count:number}>(route,{action:"read",case:caseId,endpoint,messages},controller.signal);
        if(!controller.signal.aborted&&result.count>0)void refresh(controller.signal);
      }catch{
        if(!controller.signal.aborted)for(const key of messages)settled.current.delete(key);
      }
    }
    const observer=new IntersectionObserver(entries=>{
      if(document.hidden||!document.hasFocus())return;
      for(const entry of entries)if(entry.isIntersecting){
        const key=(entry.target as HTMLElement).dataset.messageId;
        if(key&&eligible.has(key)&&!settled.current.has(key))queued.add(key);
      }
      if(queued.size){window.clearTimeout(timer);timer=window.setTimeout(()=>void flush(),350);}
    },{root:viewport,threshold:0.24});
    viewport.querySelectorAll("[data-message-id]").forEach(node=>observer.observe(node));
    const revisit=()=>{for(const node of viewport.querySelectorAll("[data-message-id]")){observer.unobserve(node);observer.observe(node);}};
    window.addEventListener("focus",revisit);document.addEventListener("visibilitychange",revisit);
    return()=>{observer.disconnect();window.clearTimeout(timer);controller.abort();window.removeEventListener("focus",revisit);document.removeEventListener("visibilitychange",revisit);};
  },[unreadKey,endpoint,caseId,route,refresh]);

  async function earlier(){
    const cursor=loadedOlder?pastCursor:thread?.before;
    if(!cursor||loadingOlder)return;
    setLoadingOlder(true);setError("");
    try{
      const startingHeight=scrollBox.current?.scrollHeight??0;
      const next=await communicationRequest<Thread>(url(cursor));
      if(scopeKey.current!==scope)return;
      setOlder(previous=>[...next.messages,...previous]);
      setPastCursor(next.before);setLoadedOlder(true);
      window.requestAnimationFrame(()=>{const box=scrollBox.current;if(box)box.scrollTop+=box.scrollHeight-startingHeight;});
    }catch(reason){if(scopeKey.current===scope)setError((reason as Error).message);}
    finally{setLoadingOlder(false);}
  }

  async function browse(){
    setShowFiles(current=>!current);
    if(files||finding)return;
    setFinding(true);setError("");
    try{
      const params=new URLSearchParams({case:caseId});
      if(audience==="staff")params.set("scope","staff");
      const result=await communicationRequest<{documents:CaseFile[]}>("/api/client-documents/list?"+params.toString());
      if(scopeKey.current===scope)setFiles(result.documents.filter(file=>!file.deleted_at&&!["Approved","Disposed"].includes(file.disposal_status??"")));
    }catch(reason){if(scopeKey.current===scope){setError((reason as Error).message);setShowFiles(false);}}
    finally{setFinding(false);}
  }

  async function send(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(sending||!thread?.writable||(!body.trim()&&!attachment))return;
    submission.current??=crypto.randomUUID();
    setSending(true);setError("");
    try{
      await communicationRequest(route,{action:"send",case:caseId,endpoint,body,attachment:attachment?.current_version_id??"",requestId:submission.current});
      if(scopeKey.current===scope){setBody("");setAttachment(null);setShowFiles(false);submission.current=null;await refresh();}
    }catch(reason){if(scopeKey.current===scope)setError((reason as Error).message);}
    finally{setSending(false);}
  }

  const more=loadedOlder?pastCursor:thread?.before;
  return <section className={styles.panel}>
    <header className={styles.heading}><Icon name="message" size={20}/><div><h2>Secure messages</h2>
      <p>{endpoint?"Office assistance for this case":"Private conversation with the assigned case team"}</p></div>
      {Boolean(thread?.unread)&&<span className={styles.badge}>{thread?.unread} unread</span>}</header>
    {audience==="client"&&Boolean(thread?.threads.length)&&<nav className={styles.channels} aria-label="Conversation channels">
      {thread?.threads.map(channel=><button type="button" className={styles.channel} key={channel.endpoint||"representative"} disabled={sending}
        aria-pressed={endpoint===channel.endpoint} onClick={()=>setEndpoint(channel.endpoint)}>
        <span>{channel.kind==="Representative"?"Case team":channel.name}</span>{channel.unread>0&&<b>{channel.unread}<span className="sr-only"> unread</span></b>}
      </button>)}
    </nav>}
    {thread&&<>
      <div className={styles.threadTitle}>{thread.label}<span>{thread.writable?"Available":"Read-only"}</span></div>
      {more&&<button type="button" className={styles.textButton} onClick={()=>void earlier()} disabled={loadingOlder}>{loadingOlder?"Loading…":"Load earlier messages"}</button>}
      <div ref={scrollBox} className={styles.thread} role="log" aria-label="Message history" tabIndex={0}>
        {displayed.length?displayed.map(message=><article className={styles.message} data-side={message.direction===own?"own":"other"} data-message-id={message.id} key={message.id}>
          <header><strong>{message.direction===own?"You":message.display_name}</strong><time dateTime={message.created_at}>{communicationDate(message.created_at)}</time></header>
          {message.body&&<p>{message.body}</p>}
          {message.document_id&&message.filename&&<button type="button" className={styles.attachment} onClick={()=>setPreview(message)}>
            <Icon name="file" size={16}/><span>{message.filename}<small>View secure copy · Version {message.version}</small></span></button>}
          {message.attachment_unavailable&&<span className={styles.muted}>The attached document is no longer available.</span>}
          {message.direction===own&&<ReadStatus stamp={message.recipient_read_at}/>}
        </article>):<p className={styles.empty}>No messages yet. Start a conversation here.</p>}
      </div>
      {thread.writable?<form className={styles.form} method="post" onSubmit={send}>
        <label>Message<textarea value={body} onChange={event=>{setBody(event.target.value);submission.current=null;}} maxLength={4000} rows={3} disabled={sending}/></label>
        {!endpoint&&showFiles&&<label>Attach a case document
          <select value={attachment?.id??""} disabled={finding||sending} onChange={event=>{setAttachment(files?.find(file=>file.id===event.target.value)??null);submission.current=null;}}>
            <option value="">{finding?"Loading case documents…":files?.length?"Choose a document":"No case documents available"}</option>
            {files?.map(file=><option key={file.id} value={file.id}>{file.filename} · Version {file.version}</option>)}
          </select>
        </label>}
        <footer>
          {!endpoint&&<button type="button" className="btn btn-outline btn-small" disabled={sending} onClick={()=>void browse()}>
            <Icon name="file" size={16}/>{showFiles?"Hide documents":attachment?"Change document":"Attach document"}</button>}
          {attachment&&<span className={styles.pin}>{attachment.filename}</span>}
          <button type="submit" className="btn btn-blue btn-small" disabled={sending||(!body.trim()&&!attachment)}>{sending?"Sending…":"Send message"}</button>
        </footer>
        {endpoint&&<p className={styles.muted}>Share sensitive case documents in your case-team conversation.</p>}
      </form>:<p className={styles.empty}>Sending is unavailable in this conversation.</p>}
    </>}
    {!thread&&!error&&<p role="status" className={styles.empty}>Loading your conversation…</p>}
    {error&&<p role="alert" className={styles.error}>{error}
      {!thread&&<button type="button" className={styles.textButton} onClick={()=>endpoint&&audience==="client"?setEndpoint(""):void refresh()}>{endpoint&&audience==="client"?"Open case team":"Try again"}</button>}
    </p>}
    {preview&&preview.document_id&&preview.version_id&&preview.filename&&preview.version&&preview.page_count&&<SecureDocumentViewer
      caseId={caseId} staff={audience==="staff"} item={{id:preview.document_id}}
      version={{id:preview.version_id,filename:preview.filename,version:preview.version,page_count:preview.page_count}} canDownload={false}
      close={()=>setPreview(null)}/>}
  </section>;
}

export function ClientConversation({caseId}:{caseId:string}){
  return <Conversation key={caseId} caseId={caseId} audience="client"/>;
}
export function StaffClientConversation({caseId}:{caseId:string}){
  return <Conversation key={caseId} caseId={caseId} audience="staff"/>;
}
export function StaffOfficeInbox(){
  const [list,setList]=useState<InboxItem[]|null>(null),[selected,setSelected]=useState<Pick<InboxItem,"case_id"|"endpoint_id">|null>(null),[error,setError]=useState("");
  useEffect(()=>{
    const query=new URLSearchParams(window.location.search),caseId=query.get("supportCase"),endpoint=query.get("supportEndpoint");
    if(caseId&&endpoint)setSelected({case_id:caseId,endpoint_id:endpoint});
    const controller=new AbortController();
    async function load(){
      try{
        const result=await communicationRequest<{inbox:InboxItem[]}>("/api/client-conversations/staff",undefined,controller.signal);
        if(!controller.signal.aborted){setList(result.inbox);setError("");}
      }catch(reason){if(!controller.signal.aborted)setError((reason as Error).message);}
    }
    void load();
    const timer=window.setInterval(()=>{if(!document.hidden)void load();},15_000);
    return()=>{window.clearInterval(timer);controller.abort();};
  },[]);
  return <section className={styles.panel} aria-label="Office conversations">
    <header className={styles.heading}><Icon name="message" size={20}/><div><h2>Office inbox</h2><p>Messages routed to authorized office and support contacts.</p></div></header>
    {error&&<p className={styles.error} role="alert">{error}</p>}
    {!list&&!error&&<p className={styles.empty} role="status">Loading office conversations…</p>}
    {list?.length===0&&!selected&&!error&&<p className={styles.empty}>Messages appear here when a client contacts an office or support desk assigned to you.</p>}
    {list&&list.length>0&&<ul className={styles.inbox}>
      {list.map(item=><li key={item.case_id+"|"+item.endpoint_id}><button type="button" aria-pressed={selected?.case_id===item.case_id&&selected.endpoint_id===item.endpoint_id} onClick={()=>setSelected(item)}>
        <span><strong>{item.client_name}</strong><small>{item.office_name} · {item.reference}</small></span><small>{item.unread>0?item.unread+" unread":communicationDate(item.latest_at)}</small>
      </button></li>)}
    </ul>}
    {selected&&<Conversation key={selected.case_id+"|"+selected.endpoint_id} caseId={selected.case_id} initialEndpoint={selected.endpoint_id} audience="staff"/>}
  </section>;
}
