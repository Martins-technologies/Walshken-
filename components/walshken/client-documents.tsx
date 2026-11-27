"use client";

import "./client-documents.css";
import { useCallback,useEffect,useRef,useState,type FormEvent } from "react";
import { clientDocumentAccept,clientDocumentCaptureNotice,clientDocumentCategories,clientDocumentMaxSize,type ClientDocumentEvent,type ClientDocumentRequest,type ClientDocumentRow,type ClientDocumentVersionRow } from "@/lib/walshken/client-document-types";
import { ClientDocumentCamera } from "./client-document-camera";
import { Icon } from "./brand";

type Policy={revision:number;retain_days:number;client_download:boolean;policy_basis:string};
type Data={documents:ClientDocumentRow[];requests:ClientDocumentRequest[];history:ClientDocumentVersionRow[];events:ClientDocumentEvent[];canManage:boolean;canConfigure:boolean;canDownload:boolean;policy:Policy|null};
type FileState={key:string;file:File;percent:number;status:"Ready"|"Uploading"|"Submitted"|"Failed";note?:string};
const pretty=(stamp:string)=>new Date(stamp).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"});
const kb=(bytes:number)=>new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(bytes/1024)+" KB";
function endpoint(action:string,caseId:string,staff:boolean,document?:string,version?:string,page?:number){
  const params=new URLSearchParams({case:caseId});
  if(staff)params.set("scope","staff");
  if(document)params.set("document",document);
  if(version)params.set("version",version);
  if(page)params.set("page",String(page));
  return `/api/client-documents/${action}?${params}`;
}
async function read<T>(url:string,options?:RequestInit):Promise<T>{
  const response=await fetch(url,{cache:"no-store",...options});
  const result=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(result?.error||"The document operation could not be completed.");
  return result;
}

function upload(url:string,body:FormData,progress:(percentage:number)=>void){
  return new Promise<string>((resolve,reject)=>{
    const transport=new XMLHttpRequest();
    transport.open("POST",url);transport.responseType="json";transport.timeout=60_000;
    transport.upload.onprogress=event=>{if(event.lengthComputable)progress(Math.min(98,Math.round(event.loaded/event.total*100)));};
    transport.onerror=()=>reject(new Error("Connection interrupted. Try this file again."));
    transport.ontimeout=()=>reject(new Error("Upload timed out. Try this file again."));
    transport.onload=()=>{
      if(transport.status<200||transport.status>=300){reject(new Error(transport.response?.error||"The file could not be uploaded."));return;}
      resolve(transport.response?.message||"Document submitted.");
    };
    transport.send(body);
  });
}

function SecureDocumentViewer({caseId,staff,item,version,canDownload,close}:{
  caseId:string;staff:boolean;item:ClientDocumentRow;version:ClientDocumentVersionRow;canDownload:boolean;close:()=>void;
}){
  const dialog=useRef<HTMLDialogElement>(null),generation=useRef(0);
  const [page,setPage]=useState(1),[source,setSource]=useState(""),[mask,setMask]=useState(true),[privacy,setPrivacy]=useState(true);
  const [error,setError]=useState(""),[downloading,setDownloading]=useState(false),[reload,setReload]=useState(0);
  useEffect(()=>{const node=dialog.current;node?.showModal();return()=>node?.close();},[]);
  useEffect(()=>{
    let localUrl="",controller:AbortController|null=null;
    const conceal=()=>{
      generation.current++;controller?.abort();
      if(localUrl){URL.revokeObjectURL(localUrl);localUrl="";}
      setSource("");setMask(true);
    };
    async function show(){
      conceal();
      if(document.visibilityState!=="visible")return;
      const active=++generation.current;
      controller=new AbortController();
      setError("");
      try{
        const response=await fetch(endpoint("preview",caseId,staff,item.id,version.id,page),{cache:"no-store",signal:controller.signal});
        if(!response.ok){const result=await response.json().catch(()=>null);throw new Error(result?.error||"Preview is unavailable.");}
        const image=await response.blob();
        if(generation.current!==active||document.visibilityState!=="visible")return;
        localUrl=URL.createObjectURL(image);
        setSource(localUrl);setMask(false);
      }catch(reason){if(generation.current===active)setError(reason instanceof Error?reason.message:"Preview is unavailable.");}
    }
    const onVisibility=()=>{if(document.visibilityState==="visible")void show();else conceal();};
    const onBlur=()=>{if(privacy)conceal();};
    const onFocus=()=>{if(privacy)void show();};
    const onLogout=()=>conceal();
    async function verify(){
      if(document.visibilityState!=="visible"||privacy&&!document.hasFocus())return;
      try{const response=await fetch(endpoint("access",caseId,staff,item.id,version.id),{cache:"no-store"});if(!response.ok){conceal();setError("Your access to this document changed. Sign in again or contact Walshken.");}}
      catch{conceal();setError("Walshken could not recheck access. Retry the preview.");}
    }
    document.addEventListener("visibilitychange",onVisibility);window.addEventListener("blur",onBlur);window.addEventListener("focus",onFocus);
    window.addEventListener("walshken:client-sign-out",onLogout);
    const timer=window.setInterval(()=>void verify(),15_000);
    void show();
    return()=>{
      clearInterval(timer);generation.current++;controller?.abort();
      if(localUrl)URL.revokeObjectURL(localUrl);
      document.removeEventListener("visibilitychange",onVisibility);window.removeEventListener("blur",onBlur);window.removeEventListener("focus",onFocus);
      window.removeEventListener("walshken:client-sign-out",onLogout);
    };
  },[caseId,staff,item.id,version.id,page,privacy,reload]);

  async function download(){
    setDownloading(true);setError("");
    try{
      const response=await fetch(endpoint("download",caseId,staff,item.id,version.id),{cache:"no-store"});
      if(!response.ok){const result=await response.json().catch(()=>null);throw new Error(result?.error||"Original download is unavailable.");}
      const url=URL.createObjectURL(await response.blob()),anchor=document.createElement("a");
      anchor.href=url;anchor.download=version.filename;anchor.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(reason){setError(reason instanceof Error?reason.message:"Original download is unavailable.");}
    finally{setDownloading(false);}
  }
  return <dialog ref={dialog} className="client-doc-dialog client-secure-doc" aria-label="Secure document preview" onCancel={close}>
    <header><div><h2>{version.filename}</h2><p>Secure preview · Version {version.version}</p></div><button type="button" className="icon-button" aria-label="Close document preview" onClick={close}><Icon name="close"/></button></header>
    <div className="client-doc-mask" onContextMenu={event=>event.preventDefault()} onDragStart={event=>event.preventDefault()}>
      {mask?<div role="status"><Icon name="lock" size={28}/><strong>{error?"Preview unavailable":"Private preview protected"}</strong><p>{error||"The page is hidden while Walshken verifies your access."}</p>{error&&<button className="btn btn-outline btn-small" type="button" onClick={()=>setReload(n=>n+1)}>Retry preview</button>}</div>:<img src={source} alt={`Watermarked image of ${version.filename}, page ${page}`} draggable={false}/>}
    </div>
    <footer><div className="client-doc-pages">
      <button type="button" className="icon-button" disabled={page<=1} aria-label="Previous page" onClick={()=>setPage(p=>p-1)}><Icon name="previous"/></button>
      <span>{page} / {version.page_count}</span>
      <button type="button" className="icon-button" disabled={page>=version.page_count} aria-label="Next page" onClick={()=>setPage(p=>p+1)}><Icon name="next"/></button>
    </div><label><input type="checkbox" checked={privacy} onChange={event=>setPrivacy(event.target.checked)}/> Mask when window loses focus</label>
      {canDownload&&<button type="button" className="btn btn-outline btn-small" disabled={downloading} onClick={()=>void download()}><Icon name="download" size={16}/>{downloading?"Checking access…":"Download original"}</button>}
    </footer>
    {!mask&&error&&<p className="form-error" role="alert">{error}</p>}
    <p className="client-doc-safety">{clientDocumentCaptureNotice}</p>
  </dialog>;
}

function UploadBox({caseId,requests,replacement,selectedRequest,close,updated}:{
  caseId:string;requests:ClientDocumentRequest[];replacement:ClientDocumentRow|null;selectedRequest:string;close:()=>void;updated:()=>void;
}){
  const chooser=useRef<HTMLInputElement>(null),cameraInput=useRef<HTMLInputElement>(null);
  const [items,setItems]=useState<FileState[]>([]),[category,setCategory]=useState<string>(clientDocumentCategories[0]),[description,setDescription]=useState("");
  const [requirement,setRequirement]=useState(selectedRequest),[camera,setCamera]=useState<File|null>(null),[drag,setDrag]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
  function add(files:File[]){
    if(busy)return;
    const valid=files.filter(file=>/\.(pdf|jpe?g|png)$/i.test(file.name)&&file.size>0&&file.size<=clientDocumentMaxSize);
    const available=replacement?1:15-items.filter(item=>item.status!=="Submitted").length;
    setError(valid.length!==files.length?"Only PDF, JPEG and PNG files up to 3 MB were added.":valid.length>available?`You can add up to ${available} more file${available===1?"":"s"} to this batch.`:"");
    setItems(current=>{
      const newItems=valid.map(file=>({key:crypto.randomUUID(),file,percent:0,status:"Ready" as const}));
      return replacement?newItems.slice(0,1):[...current.filter(item=>item.status!=="Submitted"),...newItems].slice(0,15);
    });
  }
  const update=(key:string,change:Partial<FileState>)=>setItems(current=>current.map(item=>item.key===key?{...item,...change}:item));
  async function send(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(busy)return;
    setBusy(true);setError("");
    let succeeded=0;
    for(const item of items.filter(file=>file.status!=="Submitted")){
      const body=new FormData();
      body.append("case",caseId);body.append("file",item.file);body.append("uploadId",item.key);
      if(replacement)body.append("document",replacement.id);
      else{body.append("category",category);body.append("description",description);body.append("requirement",requirement);}
      update(item.key,{percent:0,status:"Uploading",note:""});
      try{
        const note=await upload(endpoint("upload",caseId,false),body,percent=>update(item.key,{percent}));
        update(item.key,{percent:100,status:"Submitted",note});succeeded++;
      }catch(reason){update(item.key,{status:"Failed",note:reason instanceof Error?reason.message:"File could not be uploaded."});}
    }
    if(succeeded)updated();
    setBusy(false);
  }
  return <section className="client-doc-card client-doc-upload">
    <header><span className="icon-tile"><Icon name="attachment"/></span><div><h3>{replacement?"Submit a replacement":"Submit documents"}</h3><p>{replacement?`The existing version of ${replacement.filename} remains in your case history.`:"Add PDF, JPEG or PNG files. Each file can be up to 3 MB."}</p></div>{replacement&&<button className="btn btn-outline btn-small" type="button" disabled={busy} onClick={close}>Cancel replacement</button>}</header>
    <form method="post" onSubmit={send}>
      {!replacement&&<div className="client-doc-upload-fields">
        <label>Document category<select value={category} onChange={event=>setCategory(event.target.value)} disabled={busy}>{clientDocumentCategories.map(item=><option key={item}>{item}</option>)}</select></label>
        <label>Document request<select value={requirement} onChange={event=>setRequirement(event.target.value)} disabled={busy}><option value="">No specific request</option>{requests.filter(item=>["Open","Submitted","Replacement requested"].includes(item.status)).map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        <label>Description <span>(optional)</span><textarea maxLength={1000} value={description} onChange={event=>setDescription(event.target.value)} disabled={busy} rows={2} placeholder="Add details that will help staff review the file"/></label>
      </div>}
      <div className={`client-doc-drop ${drag?"drag-over":""}`} onDragOver={event=>{event.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={event=>{event.preventDefault();setDrag(false);add(Array.from(event.dataTransfer.files));}}>
        <span className="icon-tile"><Icon name="file"/></span><strong>Drop your files here</strong>
        <div><button type="button" className="btn btn-outline btn-small" disabled={busy} onClick={()=>chooser.current?.click()}>Choose files</button><button type="button" className="btn btn-outline btn-small" disabled={busy} onClick={()=>cameraInput.current?.click()}><Icon name="technology" size={16}/>Scan with camera</button></div>
        <input ref={chooser} type="file" accept={clientDocumentAccept} multiple={!replacement} hidden onChange={event=>{add(Array.from(event.target.files??[]));event.target.value="";}}/>
        <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={event=>{setCamera(event.target.files?.[0]??null);event.target.value="";}}/>
      </div>
      {!!items.length&&<ul className="client-doc-queue">{items.map(item=><li key={item.key}><div><strong>{item.file.name}</strong><small>{kb(item.file.size)} · {item.status}</small>{item.note&&<small className={item.status==="Failed"?"client-doc-file-error":""}>{item.note}</small>}{item.status==="Uploading"&&<progress value={item.percent} max={100} aria-label={`Upload progress for ${item.file.name}`}/>}</div>{(item.status==="Ready"||item.status==="Failed")&&<button className="icon-button" type="button" aria-label={`Remove ${item.file.name}`} disabled={busy} onClick={()=>setItems(current=>current.filter(row=>row.key!==item.key))}><Icon name="close" size={16}/></button>}</li>)}</ul>}
      {error&&<p className="form-error" role="alert">{error}</p>}
      <button className="btn btn-blue" type="submit" disabled={busy||!items.some(item=>item.status!=="Submitted")}><Icon name="attachment" size={17}/>{busy?"Uploading…":replacement?"Submit replacement":"Submit selected files"}</button>
    </form>
    {camera&&<ClientDocumentCamera file={camera} done={file=>{add([file]);setCamera(null);}} close={()=>setCamera(null)}/>}
  </section>;
}

function ClientCaseDocuments({caseId,staff,onChanged}:{caseId:string;staff:boolean;onChanged?:()=>void}){
  const [data,setData]=useState<Data|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [selected,setSelected]=useState(""),[replacement,setReplacement]=useState<ClientDocumentRow|null>(null),[requirement,setRequirement]=useState("");
  const [viewer,setViewer]=useState<{item:ClientDocumentRow;version:ClientDocumentVersionRow}|null>(null),[action,setAction]=useState<{item?:ClientDocumentRow;type:string}|null>(null);
  const dialog=useRef<HTMLDialogElement>(null),sequence=useRef(0);
  const reload=useCallback(async()=>{
    const seq=++sequence.current;
    try{const value=await read<Data>(endpoint("list",caseId,staff,selected));if(seq===sequence.current){setData(value);setError("");}}
    catch(reason){if(seq===sequence.current)setError(reason instanceof Error?reason.message:"Document information is unavailable.");}
  },[caseId,staff,selected]);
  useEffect(()=>{setData(null);setSelected("");setReplacement(null);setRequirement("");setViewer(null);},[caseId,staff]);
  useEffect(()=>{if(caseId)void reload();},[caseId,reload]);
  useEffect(()=>{if(action){const node=dialog.current;node?.showModal();return()=>node?.close();}},[action]);
  function current(item:ClientDocumentRow):ClientDocumentVersionRow{
    return {id:item.current_version_id,version:item.version,filename:item.filename,page_count:item.page_count,byte_size:item.byte_size,scan_status:item.scan_status,submitted_at:item.submitted_at,retain_until:item.retain_until};
  }
  const [busy,setBusy]=useState(false),[actionError,setActionError]=useState("");
  function begin(type:string,item?:ClientDocumentRow){setActionError("");setAction({type,item});}
  async function apply(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!action||busy)return;
    const form=new FormData(event.currentTarget),item=action.item;
    const body={...Object.fromEntries(form),case:caseId,document:item?.id,version:item?.current_version_id,disposal:item?.disposal_id,download:form.has("download"),revision:data?.policy?.revision??0};
    setBusy(true);setActionError("");
    try{
      const result=await read<{message:string}>(endpoint(action.type,caseId,staff),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      setAction(null);setNotice(result.message);await reload();onChanged?.();
    }catch(reason){setActionError(reason instanceof Error?reason.message:"The action could not be completed.");}
    finally{setBusy(false);}
  }
  const closeAction=()=>{setAction(null);setActionError("");};
  const labels:Record<string,string>={review:"Review submission",hold:"Place legal hold","release-hold":"Release legal hold","request-deletion":"Request deletion","decide-deletion":"Review deletion request",policy:"Retention and download policy"};
  if(!caseId)return <p className="client-doc-empty">Select a case to manage its documents.</p>;
  return <div className={`client-doc-shell ${staff?"client-doc-staff":""}`}>
    {error&&<div className="form-error" role="alert">{error} <button className="text-link" type="button" onClick={()=>void reload()}>Retry</button></div>}
    {notice&&<p className="client-doc-status" role="status">{notice}</p>}
    {!data&&!error&&<p role="status">Loading documents…</p>}
    {data&&<>
      {!staff&&<UploadBox key={`${caseId}/${replacement?.id??""}/${requirement}`} caseId={caseId} requests={data.requests} replacement={replacement} selectedRequest={requirement} close={()=>setReplacement(null)} updated={()=>{void reload();onChanged?.();}}/>}
      {!!data.requests.length&&<section className="client-doc-card">
        <header><span className="icon-tile"><Icon name="list"/></span><div><h3>Document requests</h3><p>Items Walshken asked you to provide for this case.</p></div></header>
        <ul className="client-doc-list">{data.requests.map(item=><li key={item.id}><div><strong>{item.title}</strong>{item.instructions&&<small>{item.instructions}</small>}{item.due_on&&<small>Due {item.due_on}</small>}</div><span className="client-doc-tag">{item.status}</span>{!staff&&["Open","Replacement requested"].includes(item.status)&&<button className="btn btn-outline btn-small" type="button" onClick={()=>{setReplacement(null);setRequirement(item.id);document.querySelector(".client-doc-upload")?.scrollIntoView({behavior:"smooth",block:"center"});}}>Add file</button>}</li>)}</ul>
      </section>}
      <section className="client-doc-card">
        <header><span className="icon-tile"><Icon name="file"/></span><div><h3>Submitted documents</h3><p>{staff?"Review submitted versions and manage protected records.":"Check review progress and open a secure preview."}</p></div>{data.canConfigure&&<button className="btn btn-outline btn-small" type="button" onClick={()=>begin("policy")}><Icon name="shield" size={16}/>Document policy</button>}</header>
        {!data.documents.length&&<p className="client-doc-empty">No documents have been submitted for this case.</p>}
        <ul className="client-doc-list">{data.documents.map(item=>{
          const unavailable=!!item.deleted_at||item.disposal_status==="Approved",isOpen=selected===item.id;
          return <li key={item.id} className="client-doc-record">
            <div className="client-doc-record-head"><div><strong>{item.filename}</strong><small>{item.category} · {kb(item.byte_size)} · Version {item.version}</small><small>{pretty(item.submitted_at)}</small>{item.description&&<small>{item.description}</small>}</div><span className="client-doc-tag">{item.deleted_at?"Disposed":item.disposal_status==="Approved"?"Disposal approved":item.review_status}</span></div>
            <div className="client-doc-row-actions">
              {!unavailable&&<button className="btn btn-outline btn-small" type="button" onClick={()=>setViewer({item,version:current(item)})}>Secure preview</button>}
              {!unavailable&&!staff&&<button className="btn btn-outline btn-small" type="button" onClick={()=>{setReplacement(item);document.querySelector(".client-doc-upload")?.scrollIntoView({behavior:"smooth",block:"center"});}}>Submit replacement</button>}
              <button className="text-link" type="button" aria-expanded={isOpen} onClick={()=>setSelected(isOpen?"":item.id)}>{isOpen?"Hide history":"Version history"}</button>
              {staff&&!unavailable&&<button className="btn btn-blue btn-small" type="button" onClick={()=>begin("review",item)}>Review</button>}
              {!unavailable&&(!staff||data.canManage)&&!["Requested","Approved"].includes(item.disposal_status??"")&&<button className="text-link" type="button" onClick={()=>begin("request-deletion",item)}>Request deletion</button>}
              {staff&&data.canManage&&!item.deleted_at&&<button className="text-link" type="button" onClick={()=>begin(item.hold_id?"release-hold":"hold",item)}>{item.hold_id?"Release legal hold":"Place legal hold"}</button>}
              {staff&&data.canManage&&item.disposal_status==="Requested"&&<button className="btn btn-outline btn-small" type="button" onClick={()=>begin("decide-deletion",item)}>Review deletion request</button>}
            </div>
            {item.disposal_status==="Requested"&&<small>Deletion request under review.</small>}
            {staff&&item.hold_id&&<small>Legal hold active.</small>}
            {isOpen&&<div className="client-doc-history">
              {!data.history.length&&<p>Loading version history…</p>}
              {data.history.map(version=><div key={version.id}><span><strong>Version {version.version}</strong><small>{version.filename} · {pretty(version.submitted_at)}{staff?` · ${version.scan_status}`:""}</small></span>{!unavailable&&<button type="button" className="btn btn-outline btn-small" onClick={()=>setViewer({item,version})}>Secure preview</button>}</div>)}
              {staff&&!!data.events.length&&<details><summary>Audit history</summary><ul>{data.events.map(event=><li key={event.id}><strong>{event.action}</strong> · {event.actor_kind} · {pretty(event.occurred_at)}{event.detail&&<small>{event.detail}</small>}</li>)}</ul></details>}
            </div>}
          </li>;
        })}</ul>
      </section>
    </>}
    {viewer&&<SecureDocumentViewer key={viewer.version.id} item={viewer.item} version={viewer.version} caseId={caseId} staff={staff} canDownload={!!data?.canDownload} close={()=>setViewer(null)}/>}
    {action&&<dialog ref={dialog} className="client-doc-dialog" aria-label={labels[action.type]} onCancel={closeAction}>
      <header><div><h2>{labels[action.type]}</h2>{action.item&&<p>{action.item.filename}</p>}</div><button type="button" className="icon-button" aria-label="Close" onClick={closeAction}><Icon name="close"/></button></header>
      <form method="post" className="client-doc-decision" onSubmit={apply}>
        {action.type==="policy"?<>
          <label>Retention for new documents (days)<input name="retention" type="number" min={1} max={36500} defaultValue={data?.policy?.retain_days??365} required/></label>
          <label>Reviewed policy basis<textarea name="basis" maxLength={1500} defaultValue={data?.policy?.policy_basis??""} required/></label>
          <label className="client-doc-check"><input name="download" type="checkbox" defaultChecked={data?.policy?.client_download}/> Allow clients to download their own originals after password confirmation</label>
        </>:<>
          {action.type==="review"&&<label>Review decision<select name="decision"><option>Accepted</option><option>Replacement requested</option></select></label>}
          {action.type==="decide-deletion"&&<label>Deletion decision<select name="decision"><option>Declined</option><option>Approved</option></select></label>}
          {action.type==="decide-deletion"&&<p>Approval requires eligible retention dates and applies to all versions of this document. A legal hold blocks disposal.</p>}
          <label>{action.type==="review"?"Client-visible review note":"Reason"}<textarea name="reason" minLength={1} maxLength={action.type==="review"?1000:1200} required/></label>
        </>}
        {actionError&&<p className="form-error" role="alert">{actionError}</p>}
        <button className="btn btn-blue" type="submit" disabled={busy}>{busy?"Saving…":"Save"}</button>
      </form>
    </dialog>}
  </div>;
}

export function ClientDocuments({caseId}:{caseId:string}){return <ClientCaseDocuments staff={false} caseId={caseId}/>;}
export function StaffClientDocuments({caseId,onChanged}:{caseId:string;onChanged?:()=>void}){return <ClientCaseDocuments staff caseId={caseId} onChanged={onChanged}/>;}
