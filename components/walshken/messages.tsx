"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { countries, messageReactions } from "@/lib/walshken/catalog";
import { Icon } from "./brand";
import { ActionForm, api, dateText, Empty, initials, options, Quick, Status, Table, value, type Field, type RecordRow } from "./ui";
import type { ViewData } from "./workspace-views";
import type { Viewer } from "./workspace";

type ChatDocument = { id: string; name: string };
type Thread = {rows:RecordRow[];members:RecordRow[];next:string|null};
const emptyThread:Thread={rows:[],members:[],next:null};
const administrator=(actor:Viewer)=>actor.role==="super_admin"||actor.role==="admin";
const groupName=(kind:unknown)=>kind==="Direct"?"Direct message":kind==="Private"?"Management":kind==="External"?"Guest conversation":String(kind??"Group");
const field=(name:string,label:string,type="text"):Field=>({name,label,type,required:true});

function ChatDialog({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}) {
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    const node=dialog.current;
    node?.showModal();
    return()=>node?.close();
  },[]);
  return <dialog ref={dialog} className="chat-dialog" aria-label={title} onCancel={onClose} onClick={event=>{if(event.target===event.currentTarget)onClose();}}>
    <div className="chat-dialog-heading"><h2>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close"/></button></div>
    {children}
  </dialog>;
}

function DocumentPicker({conversation, onSelect, onClose}:{conversation:string;onSelect:(document:ChatDocument)=>void;onClose:()=>void}) {
  const [query,setQuery]=useState(""),[documents,setDocuments]=useState<ChatDocument[]>([]);
  const [busy,setBusy]=useState(true),[error,setError]=useState("");
  const search=useRef(0);

  const load=useCallback(async (filter:string)=>{
    const request=++search.current;
    setBusy(true);setError("");
    try{
      const params=new URLSearchParams({conversation,q:filter});
      const result=await api("messages/attachments?"+params.toString()) as {documents:ChatDocument[]};
      if(search.current===request)setDocuments(result.documents);
    }catch(reason){
      if(search.current===request)setError(reason instanceof Error?reason.message:"Unable to load documents.");
    }finally{
      if(search.current===request)setBusy(false);
    }
  },[conversation]);

  useEffect(()=>{
    void load("");
    return ()=>{search.current++;};
  },[load]);

  return <ChatDialog title="Attach a document" onClose={onClose}>
    <p className="chat-file-help">Choose a file from Documents. Everyone in this conversation must already have access.</p>
    <form className="chat-file-search" onSubmit={event=>{event.preventDefault();void load(query);}}>
      <label className="chat-dialog-field">Document name<input value={query} maxLength={100} onChange={event=>setQuery(event.target.value)} /></label>
      <button className="btn btn-outline btn-small" type="submit" disabled={busy}>Search</button>
    </form>
    {error&&<p role="alert" className="form-error">{error}</p>}
    {busy?<p role="status">Loading documents…</p>:documents.length>0&&!error?
      <div className="chat-file-options">{documents.map(document=><button type="button" key={document.id} onClick={()=>onSelect(document)}>
        <Icon name="file" size={20}/><span>{document.name}</span>
      </button>)}</div>:!error&&<p>No shareable documents match. <a href="/staff/documents">Open Documents</a></p>}
  </ChatDialog>;
}

export function Messages({data,actor,refresh}:{data:ViewData;actor:Viewer;refresh:()=>void}) {
  const [target,setTarget]=useState(""),[thread,setThread]=useState<Thread>(emptyThread);
  const [history,setHistory]=useState<string[]>([]),[query,setQuery]=useState(""),[search,setSearch]=useState("");
  const [archived,setArchived]=useState(false),[pinned,setPinned]=useState(false),[body,setBody]=useState("");
  const [attachment,setAttachment]=useState<ChatDocument|null>(null);
  const [reply,setReply]=useState<RecordRow|null>(null),[editing,setEditing]=useState<RecordRow|null>(null);
  const [forward,setForward]=useState<RecordRow|null>(null),[dialog,setDialog]=useState(""),[kind,setKind]=useState("Direct");
  const [error,setError]=useState(""),[sending,setSending]=useState(false),[loading,setLoading]=useState(false);
  const [mobileThread,setMobileThread]=useState(false),[caret,setCaret]=useState(0),[mentionIndex,setMentionIndex]=useState(0);
  const [dismissMention,setDismissMention]=useState(false),[unseen,setUnseen]=useState(false);
  const editor=useRef<HTMLTextAreaElement>(null),scroller=useRef<HTMLDivElement>(null);
  const sequence=useRef(0),busy=useRef(false),latest=useRef(""),lastRead=useRef("");
  const before=history.at(-1)??"";
  const key=JSON.stringify([target,search,before,pinned]);
  const activeKey=useRef(key);
  const activeTarget=useRef(target);
  activeKey.current=key;
  activeTarget.current=target;
  const current=data.rows?.find(row=>row.id===target);
  const isAdmin=administrator(actor);
  const policy=data.communicationPolicy;
  const members=thread.members;
  const canMembers=isAdmin||(actor.role!=="guest"&&current?.kind!=="External"&&
    (data.memberManagement==="Members"||(current?.created_by===actor.id&&data.memberManagement!=="Super Admin")));
  const canPin=isAdmin||current?.created_by===actor.id;
  const canRemoveGroup=current&&current.kind!=="Direct"&&actor.role!=="guest"
    &&(actor.role==="super_admin"||current.created_by===actor.id&&(current.kind!=="External"||isAdmin));
  const escapedQuery=body.slice(0,caret).match(/(?:^|\s)@([^@\n]{0,60})$/);
  const suggestions=!editing&&!dismissMention&&escapedQuery
    ?members.filter(member=>member.id!==actor.id&&value(member,"name").toLowerCase().includes(escapedQuery[1].toLowerCase())).slice(0,6):[];
  const inHistory=!!before||!!search||pinned;
  const people=(data.staff??[]).filter(row=>row.id!==actor.id&&(kind==="External"||row.role!=="Guest"));
  const channels=(data.rows??[]).filter(row=>Boolean(row.archived)===archived&&value(row,"title").toLowerCase().includes(query.toLowerCase()));
  const destinations=(data.rows??[]).filter(row=>row.id!==target&&row.kind!=="External");
  const pending=data.pendingGroups??[];
  const removedGroups=data.removedGroups??[];

  useEffect(()=>{
    const requested=new URLSearchParams(window.location.search).get("conversation");
    if(requested){setTarget(requested);setMobileThread(true);}
  },[]);
  useEffect(()=>{
    const timer=setInterval(()=>{if(document.visibilityState==="visible")refresh();},10000);
    const focus=()=>refresh();
    window.addEventListener("focus",focus);
    return()=>{clearInterval(timer);window.removeEventListener("focus",focus);};
  },[refresh]);

  const load=useCallback(async(showLoading=false)=>{
    if(!target||busy.current&&!showLoading)return;
    const request=++sequence.current;
    const requestKey=key;
    busy.current=true;
    if(showLoading)setLoading(true);
    try {
      const params=new URLSearchParams({q:search,before,pinned:pinned?"1":"0"});
      const result=await api(`conversation/${encodeURIComponent(target)}?${params}`) as Thread;
      if(activeKey.current!==requestKey||sequence.current!==request)return;
      const panel=scroller.current;
      const nearBottom=!panel||panel.scrollHeight-panel.scrollTop-panel.clientHeight<100;
      const last=value(result.rows.at(-1),"id");
      const newMessage=latest.current!==last;
      latest.current=last;
      setThread(result);setError("");setLoading(false);
      if(!before&&!search&&!pinned&&newMessage) {
        if(nearBottom||showLoading)requestAnimationFrame(()=>{const node=scroller.current;if(node&&activeKey.current===requestKey)node.scrollTop=node.scrollHeight;});
        else setUnseen(true);
      }
      const readAt=value(result.members.find(member=>member.id===actor.id),"last_read_at");
      const through=result.rows.at(-1);
      if(!search&&!pinned&&through&&value(through,"created_at")>readAt&&lastRead.current!==last&&document.visibilityState==="visible"){
        lastRead.current=last;
        api("messages/read",{conversation:target,through:last}).then(refresh,()=>{if(lastRead.current===last)lastRead.current="";});
      }
    }catch(reason){
      if(activeKey.current!==requestKey||sequence.current!==request)return;
      setThread(emptyThread);setError(reason instanceof Error?reason.message:"Unable to load this conversation.");setLoading(false);
    }finally{if(sequence.current===request)busy.current=false;}
  },[actor.id,before,key,pinned,refresh,search,target]);

  useEffect(()=>{
    setThread(emptyThread);setError("");setUnseen(false);latest.current="";
    void load(true);
    const timer=setInterval(()=>{if(document.visibilityState==="visible")void load();},5000);
    const focus=()=>void load();
    window.addEventListener("focus",focus);
    return()=>{clearInterval(timer);window.removeEventListener("focus",focus);};
  },[load]);
  useEffect(()=>{
    if(target&&!current){setThread(emptyThread);setReply(null);setEditing(null);setForward(null);setBody("");setAttachment(null);}
  },[target,current]);

  function select(id:string){
    setTarget(id);setHistory([]);setSearch("");setPinned(false);setReply(null);setEditing(null);setForward(null);setBody("");setAttachment(null);
    setDismissMention(false);setMobileThread(Boolean(id));setDialog("");setError("");
    const url=new URL(window.location.href);
    if(id)url.searchParams.set("conversation",id);else url.searchParams.delete("conversation");
    window.history.replaceState(null,"",url);
  }
  function insertMention(member:RecordRow){
    if(!escapedQuery)return;
    const start=caret-escapedQuery[1].length-1;
    const name=`@${member.name} `;
    const content=body.slice(0,start)+name+body.slice(caret);
    if(content.length>4000)return;
    const position=start+name.length;
    setBody(content);setCaret(position);setDismissMention(true);
    requestAnimationFrame(()=>{editor.current?.focus();editor.current?.setSelectionRange(position,position);});
  }
  function composerKey(event:KeyboardEvent<HTMLTextAreaElement>){
    if(event.nativeEvent.isComposing)return;
    if(suggestions.length){
      if(event.key==="ArrowDown"||event.key==="ArrowUp"){
        event.preventDefault();
        setMentionIndex(index=>(index+(event.key==="ArrowDown"?1:suggestions.length-1))%suggestions.length);return;
      }
      if(event.key==="Enter"||event.key==="Tab"){event.preventDefault();insertMention(suggestions[mentionIndex%suggestions.length]);return;}
      if(event.key==="Escape"){event.preventDefault();setDismissMention(true);return;}
    }
    if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();editor.current?.form?.requestSubmit();}
  }
  async function send(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(sending||(!body.trim()&&(editing||!attachment))||!current)return;
    const requestTarget=target,content=body;
    setSending(true);setError("");
    try{
      const mentions=members.filter(member=>member.id!==actor.id&&content.includes(`@${member.name}`)).map(member=>member.id);
      await api(editing?"messages/edit":"messages/send",{conversation:requestTarget,body:content,reply:reply?.id,id:editing?.id,mentions:editing?[]:mentions,document:editing?undefined:attachment?.id});
      if(activeTarget.current!==requestTarget)return;
      setBody("");setCaret(0);setReply(null);setEditing(null);setAttachment(null);setDismissMention(false);
      if(inHistory){setHistory([]);setSearch("");setPinned(false);}else await load();
      refresh();
      requestAnimationFrame(()=>editor.current?.focus());
    }catch(reason){setError(reason instanceof Error?reason.message:"Unable to send your message.");}
    finally{setSending(false);}
  }
  const scope:Field[]=kind==="Department"?[{name:"department",label:"Department",options:options(data.departments??[]),required:true}]
    :kind==="Project"?[{name:"project",label:"Project",options:options(data.projects??[]),required:true}]
    :kind==="Country"?[{name:"country",label:"Country",options:countries.map(country=>[country.code,country.name]),required:true}]
    :kind==="Temporary"?[field("closesAt","Close conversation at","datetime-local")]:[];

  return <section className={`chat-workspace ${mobileThread?"show-thread":""}`} aria-label="Messaging">
    <aside className="chat-sidebar">
      <div className="chat-sidebar-title"><div><h2>Messages</h2><span>{(data.rows??[]).filter(row=>!row.archived).length} conversations</span></div>
        {actor.role!=="guest"&&<button className="chat-new btn btn-small" type="button" onClick={()=>{setKind("Direct");setDialog("new");}}><Icon name="plus" size={17}/> New message</button>}
      </div>
      <label className="chat-find"><Icon name="search" size={17}/><span className="sr-only">Find a conversation</span>
        <input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Find a conversation" maxLength={100}/></label>
      <div className="chat-tabs" aria-label="Conversation filter">
        <button type="button" aria-pressed={!archived} onClick={()=>setArchived(false)}>Inbox</button>
        <button type="button" aria-pressed={archived} onClick={()=>setArchived(true)}>Archived</button>
      </div>
      {removedGroups.length>0&&<button type="button" className="text-link" onClick={()=>setDialog("removed-groups")}>Removed groups</button>}
      <nav className="chat-conversations" aria-label="Conversations">
        {channels.map(row=><button type="button" className={`chat-channel ${target===row.id?"selected":""}`} key={value(row,"id")} aria-current={target===row.id?"true":undefined} onClick={()=>select(value(row,"id"))}>
          <span className={`chat-avatar ${row.kind==="Direct"?"person":"group"}`}>{row.kind==="Direct"?initials(value(row,"title")):<Icon name={row.kind==="Private"?"lock":row.kind==="External"?"globe":"hash"} size={20}/>}</span>
          <span className="chat-channel-copy"><strong>{row.title}</strong><small>{row.preview||groupName(row.kind)}</small></span>
          <span className="chat-channel-meta">{row.last_message_at&&<time>{new Intl.DateTimeFormat("en",{hour:"numeric",minute:"2-digit",timeZone:actor.timeZone}).format(new Date(String(row.last_message_at)))}</time>}
            {Number(row.unread)>0&&<b aria-label={`${row.unread} unread messages`}>{Number(row.unread)>99?"99+":row.unread}</b>}</span>
        </button>)}
        {!channels.length&&<div className="chat-list-empty"><Icon name={archived?"history":"message"} size={28}/><strong>{query?"No conversations found":archived?"No archived conversations":"Your conversations start here"}</strong>
          <p>{query?"Try another name.":archived?"Archived chats will appear here.":"Choose a teammate to start a conversation."}</p>
          {!query&&!archived&&actor.role!=="guest"&&<button type="button" className="btn btn-outline btn-small" onClick={()=>{setKind("Direct");setDialog("new");}}>New message</button>}
        </div>}
      </nav>
      {isAdmin&&<div className="chat-admin-bar">
        {policy&&<button type="button" onClick={()=>setDialog("policy")}><Icon name="settings" size={17}/>Messaging policy</button>}
        <button type="button" onClick={()=>setDialog("requests")}><Icon name="users" size={17}/>Group requests{pending.length>0&&<b>{pending.length}</b>}</button>
      </div>}
    </aside>
    <div className="chat-main">
      {!current?<div className="chat-welcome"><span className="chat-welcome-icon"><Icon name="message" size={40}/></span>
        <h2>A space to keep work moving.</h2><p>Open a conversation with your team. Messages and shared discussions stay within your permitted workspace.</p>
        {actor.role!=="guest"&&<button className="btn btn-blue" type="button" onClick={()=>setDialog("new")}><Icon name="plus" size={18}/>Start a conversation</button>}
        <button className="chat-mobile-back" type="button" onClick={()=>setMobileThread(false)}>View conversations</button>
      </div>:<>
        <header className="chat-header">
          <button className="icon-button chat-mobile-back" type="button" aria-label="Back to conversations" onClick={()=>setMobileThread(false)}><Icon name="left"/></button>
          <span className="chat-avatar group"><Icon name={current.kind==="Direct"?"user":current.kind==="Private"?"lock":"hash"} size={22}/></span>
          <div className="chat-heading-copy"><h2>{current.title}</h2><button type="button" onClick={()=>setDialog("members")}>{groupName(current.kind)} · {members.length} participants</button></div>
          <button className="icon-button" type="button" aria-label="Conversation participants" onClick={()=>setDialog("members")}><Icon name="users"/></button>
          <Quick path="messages/archive" data={{conversation:target,archived:current.archived?"0":"1"}} refresh={refresh}>{current.archived?"Restore":"Archive"}</Quick>
        </header>
        <div className="chat-toolbar"><label className="chat-find"><Icon name="search" size={17}/><span className="sr-only">Search messages</span>
          <input value={search} onChange={event=>{setSearch(event.target.value);setHistory([]);}} maxLength={100} placeholder="Search in this conversation"/></label>
          <button type="button" aria-pressed={pinned} className={`chat-pin-filter ${pinned?"active":""}`} onClick={()=>{setPinned(!pinned);setHistory([]);}}><Icon name="pin" size={17}/>Pinned</button>
        </div>
        <div className="chat-page-nav">
          <button className="text-link" type="button" disabled={!thread.next||loading} onClick={()=>{if(thread.next)setHistory(previous=>[...previous,thread.next!]);}}><Icon name="previous" size={15}/>Earlier</button>
          <span>{loading?"Loading messages…":search?"Search results":pinned?"Pinned messages":before?"Earlier messages":"Latest messages"}</span>
          <button className="text-link" type="button" disabled={!before||loading} onClick={()=>setHistory(previous=>previous.slice(0,-1))}>Newer<Icon name="next" size={15}/></button>
          {before&&<button className="text-link" type="button" onClick={()=>setHistory([])}>Latest</button>}
        </div>
        <div className="chat-timeline" ref={scroller} aria-label="Messages" aria-live="polite" aria-busy={loading} onScroll={()=>{const node=scroller.current;if(node&&node.scrollHeight-node.scrollTop-node.clientHeight<80)setUnseen(false);}}>
          {!loading&&!thread.rows.length&&<Empty icon="message" title={error?"Conversation unavailable":search?"No messages match your search":pinned?"No pinned messages":"Say hello to your team"} body={error?"Refresh the conversation to check your access.":search?"Try a different word.":pinned?"Pin a message to keep it easy to find.":"Send the first message below."}/>}
          {thread.rows.map((row,index)=>{
            const own=row.sender_id===actor.id,removed=!!row.deleted_at;
            const readers=members.filter(member=>member.id!==actor.id&&value(member,"last_read_at")>=value(row,"created_at"));
            const day=value(row,"created_at").slice(0,10);
            const separator=index===0||day!==value(thread.rows[index-1],"created_at").slice(0,10);
            return <div key={value(row,"id")}>
              {separator&&<div className="chat-day"><span>{dateText(row.created_at,false,actor.timeZone)}</span></div>}
              <article className={`chat-post ${own?"own":""}`} aria-label={`Message from ${row.name}`}>
                {!own&&<span className="chat-avatar person">{initials(value(row,"name"))}</span>}
                <div className="chat-post-content"><div className="chat-post-heading"><strong>{own?"You":row.name}</strong><time title={dateText(row.created_at,true,actor.timeZone)}>{new Intl.DateTimeFormat("en",{hour:"numeric",minute:"2-digit",timeZone:actor.timeZone}).format(new Date(String(row.created_at)))}</time>
                  {!!row.edited_at&&<small>edited</small>}{!!row.forwarded&&<small>forwarded</small>}{!!row.pinned&&<span className="chat-pinned-tag"><Icon name="pin" size={12}/>Pinned</span>}
                </div>
                <div className={`chat-bubble ${removed?"removed":""}`}>
                  {row.reply_name&&!removed&&<blockquote><strong>{row.reply_name}</strong><p>{String(row.reply_body).slice(0,160)}</p></blockquote>}
                  {(removed||row.body)&&<p>{removed?"This message was removed.":row.body}</p>}
                  {!removed&&row.attachment_id&&<a className="chat-file-card" href={"/staff/documents?document="+encodeURIComponent(String(row.attachment_id))}>
                    <Icon name="file" size={20}/><span><strong>{row.attachment_name}</strong><small>Open in Documents</small></span>
                  </a>}
                  {!removed&&!!row.attachment_unavailable&&<span className="chat-file-unavailable">Document unavailable</span>}
                </div>
                {!removed&&<div className="chat-post-footer">
                  {String(row.reactions??"").trim()&&<div className="chat-reaction-counts">{messageReactions.filter(emoji=>String(row.reactions).includes(emoji)).map(emoji=><Quick key={emoji} path="messages/reaction" data={{conversation:target,id:row.id,emoji}} refresh={()=>void load()}>{emoji} {String(row.reactions).split(" ").filter(item=>item===emoji).length}</Quick>)}</div>}
                  <details className="chat-message-actions"><summary aria-label="Message actions"><Icon name="more" size={18}/></summary><div>
                    <button type="button" onClick={()=>{setReply(row);setEditing(null);editor.current?.focus();}}>Reply</button>
                    {data.canForwardMessages&&current.kind!=="External"&&destinations.length>0&&<button type="button" onClick={()=>setForward(row)}>Forward</button>}
                    {canPin&&<Quick path="messages/pin" data={{conversation:target,id:row.id,pinned:row.pinned?"0":"1"}} refresh={()=>void load()}>{row.pinned?"Unpin":"Pin"}</Quick>}
                    {own&&data.messageChanges!=="Locked"&&<button type="button" onClick={()=>{setEditing(row);setReply(null);setAttachment(null);setBody(value(row,"body"));setDismissMention(true);editor.current?.focus();}}>Edit</button>}
                    {(own||actor.role==="super_admin"&&data.messageChanges==="Sender or Super Admin")&&data.messageChanges!=="Locked"&&<button className="chat-remove" type="button" onClick={()=>setDialog(`remove:${row.id}`)}>Remove</button>}
                    <div className="chat-reaction-picker" aria-label="React to message">{messageReactions.map(emoji=><Quick key={emoji} path="messages/reaction" data={{conversation:target,id:row.id,emoji}} refresh={()=>void load()}>{emoji}</Quick>)}</div>
                  </div></details>
                  {own&&<span className="chat-read-status" title={readers.map(member=>member.name).join(", ")}><Icon name="tick" size={13}/>{readers.length?`Read by ${readers.length}`:"Sent"}</span>}
                </div>}
                </div>
              </article>
            </div>;
          })}
        </div>
        {unseen&&!inHistory&&<button type="button" className="chat-new-messages" onClick={()=>{const node=scroller.current;if(node)node.scrollTop=node.scrollHeight;setUnseen(false);}}>New messages<Icon name="down" size={15}/></button>}
        {error&&<div className="chat-error" role="alert"><Icon name="alert" size={17}/>{error}<button type="button" onClick={()=>void load(true)}>Retry</button></div>}
        <form className="chat-compose" onSubmit={send}>
          {(reply||editing)&&<div className="chat-compose-context"><Icon name={editing?"file":"message"} size={17}/><div><strong>{editing?"Edit your message":`Replying to ${reply?.name}`}</strong>{reply&&<span>{String(reply.body).slice(0,110)}</span>}</div>
            <button type="button" className="icon-button" aria-label="Cancel reply or editing" onClick={()=>{setReply(null);setEditing(null);setBody("");}}><Icon name="close" size={17}/></button></div>}
          {attachment&&!editing&&<div className="chat-compose-context">
            <Icon name="file" size={18}/><div><strong>{attachment.name}</strong><span>Private document</span></div>
            <button type="button" className="icon-button" aria-label="Remove attached document" onClick={()=>setAttachment(null)}><Icon name="close" size={17}/></button>
          </div>}
          <div className="chat-compose-box">
            {suggestions.length>0&&<div className="chat-mention-menu" role="listbox" id="mention-options" aria-label="Mention a participant">{suggestions.map((member,index)=><button type="button" role="option" id={`mention-option-${index}`} key={value(member,"id")} aria-selected={index===mentionIndex%suggestions.length} onMouseDown={event=>event.preventDefault()} onClick={()=>insertMention(member)}><span className="chat-avatar person">{initials(value(member,"name"))}</span><span>{member.name}</span></button>)}</div>}
            <label className="sr-only" htmlFor="message-composer">Message</label>
            <textarea id="message-composer" ref={editor} rows={2} value={body} maxLength={4000} placeholder={`Message ${current.title}…`}
              aria-controls={suggestions.length?"mention-options":undefined} aria-activedescendant={suggestions.length?`mention-option-${mentionIndex%suggestions.length}`:undefined}
              onChange={event=>{setBody(event.target.value);setCaret(event.target.selectionStart);setDismissMention(false);setMentionIndex(0);}}
              onSelect={event=>setCaret(event.currentTarget.selectionStart)} onKeyDown={composerKey} disabled={sending}/>
            <div className="chat-compose-bottom"><div className="chat-compose-tools">
              {data.messageDocumentsEnabled&&current.kind!=="External"&&!editing&&<button type="button" className="chat-attach" onClick={()=>setDialog("attach")} disabled={sending}>
                <Icon name="file" size={17}/> Attach document
              </button>}<span><kbd>@</kbd> Mention · <kbd>Shift ↵</kbd> New line</span></div><button className="btn btn-blue" type="submit" disabled={sending||(!body.trim()&&(!!editing||!attachment))||loading}><span>{sending?"Sending…":editing?"Save":"Send"}</span><Icon name="send" size={17}/></button></div>
          </div>
        </form>
      </>}
    </div>

    {dialog==="attach"&&current&&<DocumentPicker conversation={target} onClose={()=>setDialog("")} onSelect={document=>{setAttachment(document);setDialog("");editor.current?.focus();}}/>}
    {dialog==="new"&&<ChatDialog title="New conversation" onClose={()=>setDialog("")}><label className="chat-dialog-field">Conversation type<select value={kind} onChange={event=>setKind(event.target.value)}>{["Direct",...(data.groups??[])].map(type=><option key={type}>{type}</option>)}</select></label>
      {people.length===0?<p>No eligible recipients. Ask your administrator to check department and reporting-manager assignments.</p>:<ActionForm key={kind} path="messages/create" fields={[...(kind==="Direct"?[]:[field("title","Name"),...scope]),
        {name:"members",label:kind==="Direct"?"Teammate":"Participants",options:options(people),multiple:kind!=="Direct",required:true},
      ]} extra={{kind}} submit={kind==="Direct"?"Open conversation":"Create group"} refresh={refresh} onDone={result=>{if(result.id){setArchived(false);select(result.id);}else setDialog("requests");}}/>}
    </ChatDialog>}
    {dialog==="members"&&current&&<ChatDialog title="Conversation participants" onClose={()=>setDialog("")}>
      <div className="chat-member-list">{members.map(member=><div key={value(member,"id")}><span className="chat-avatar person">{initials(value(member,"name"))}</span><span><strong>{member.name}</strong><small>{member.id===current.created_by?"Conversation owner":member.role==="guest"?"Guest":"Participant"}</small></span>
        {canMembers&&current.kind!=="Direct"&&member.id!==current.created_by&&<Quick path="messages/member" data={{conversation:target,operation:"remove",employee:member.id}} refresh={()=>{void load();refresh();}}>Remove</Quick>}</div>)}</div>
      {canMembers&&current.kind!=="Direct"&&<ActionForm path="messages/member" fields={[{name:"employee",label:"Invite participant",options:options((data.staff??[]).filter(row=>!members.some(member=>member.id===row.id)&&(current.kind==="External"||row.role!=="Guest"))),required:true}]}
        extra={{conversation:target,operation:"add"}} submit="Add participant" refresh={()=>{void load();refresh();}}/>}
      {canRemoveGroup&&<button type="button" className="btn btn-outline btn-small" onClick={()=>setDialog("remove-group")}>Remove group</button>}
    </ChatDialog>}
    {dialog==="remove-group"&&canRemoveGroup&&<ChatDialog title="Remove group?" onClose={()=>setDialog("")}>
      <p>This takes the group out of everyone’s Messages and ends access granted through group membership. The owner or a Super Admin can restore it.</p>
      <Quick path="messages/remove-group" data={{conversation:target}} refresh={refresh} onDone={()=>select("")}>Remove group for everyone</Quick>
    </ChatDialog>}
    {dialog==="removed-groups"&&<ChatDialog title="Removed groups" onClose={()=>setDialog("")}>
      <Table rows={removedGroups} columns={[{key:"title",title:"Group"},{key:"kind",title:"Type"}]} empty="No removed groups"
        actions={row=><Quick path="messages/restore-group" data={{conversation:row.id}} refresh={refresh} onDone={()=>setDialog("")}>Restore group</Quick>}/>
    </ChatDialog>}
    {dialog==="requests"&&<ChatDialog title="Group requests" onClose={()=>setDialog("")}><Table rows={pending} columns={[{key:"title",title:"Group"},{key:"kind",title:"Type"},{key:"name",title:"Requested by"}]} empty="No group requests awaiting review" actions={row=><><Quick path="messages/review" data={{conversation:row.id,status:"Active"}} refresh={refresh}>Approve</Quick><Quick path="messages/review" data={{conversation:row.id,status:"Rejected"}} refresh={refresh}>Decline</Quick></>}/></ChatDialog>}
    {dialog==="policy"&&policy&&<ChatDialog title="Messaging policy" onClose={()=>setDialog("")}>
      <ActionForm path="communication-policy/save" fields={[
        {name:"creation",label:"Who may create groups",options:[["Super Admin","Administrators only"],["Managers","Administrators and coordinators"],["All staff","All employees"]],value:policy.group_creation,required:true},
        {name:"approval",label:"Group requests",options:[["0","Create immediately"],["1","Administrator approval required"]],value:policy.group_approval,required:true},
        {name:"members",label:"Who may manage participants",options:[["Super Admin","Administrators only"],["Owners","Administrators and group owners"],["Members","All group members"]],value:policy.member_management,required:true},
        {name:"forwarding",label:"Internal forwarding",options:[["Disabled","Disabled"],["Managers","Administrators and coordinators"],["All staff","All employees"]],value:policy.message_forwarding,required:true},
        {name:"external",label:"Guest conversations",options:[["0","Disabled"],["1","Administrator invitations only"]],value:policy.external_messaging,required:true},
        {name:"messageChanges",label:"Editing and removal",options:[["Sender","Sender only"],["Sender or Super Admin","Sender, with Super Admin moderation"],["Locked","Disabled"]],value:policy.message_changes,required:true},
        {name:"retentionDays",label:"Message history in days (0 keeps all)",type:"number",min:0,max:3650,value:policy.message_retention_days,required:true},
      ]} submit="Save messaging policy" refresh={refresh} reset={false}/>
      {Number(policy.message_retention_days)>0&&<details className="chat-retention"><summary>Remove expired content</summary><p>Expired content is hidden automatically. This permanently clears its text and reactions from storage.</p><ActionForm path="communication-policy/apply-retention" fields={[field("confirmation","Type ERASE to confirm")]} submit="Clear expired content" refresh={refresh}/></details>}
    </ChatDialog>}
    {forward&&<ChatDialog title="Forward message" onClose={()=>setForward(null)}><div className="chat-forward-preview">{forward.body||forward.attachment_name||"Shared document"}</div><ActionForm path="messages/forward" fields={[{name:"destination",label:"Conversation",options:options(destinations,"title"),required:true}]} extra={{conversation:target,id:forward.id}} submit="Forward" refresh={refresh} onDone={()=>setForward(null)}/></ChatDialog>}
    {dialog.startsWith("remove:")&&<ChatDialog title="Remove this message?" onClose={()=>setDialog("")}><p>The message text will be removed for everyone in this conversation.</p><Quick path="messages/delete" data={{conversation:target,id:dialog.slice(7)}} refresh={()=>{void load();setDialog("");}}>Remove message</Quick></ChatDialog>}
  </section>;
}
