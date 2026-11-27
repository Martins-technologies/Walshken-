"use client";

import { useEffect,useRef,useState,type FormEvent } from "react";
import { clientDocumentCategories,type ClientWatermarkPolicy } from "@/lib/walshken/client-document-types";
import { Icon } from "./brand";

export function ClientDocumentWatermarkSettings({caseId,value,onClose,onSaved}:{
  caseId:string;value:ClientWatermarkPolicy;onClose:()=>void;onSaved:(message:string)=>void;
}) {
  const dialog=useRef<HTMLDialogElement>(null),sampleUrl=useRef(""),inFlight=useRef<AbortController|null>(null);
  const [proposed,setProposed]=useState(value),[sample,setSample]=useState(""),[busy,setBusy]=useState<"sample"|"save"|null>(null),[error,setError]=useState("");
  useEffect(()=>{
    const node=dialog.current;
    node?.showModal();
    return ()=>{node?.close();inFlight.current?.abort();if(sampleUrl.current)URL.revokeObjectURL(sampleUrl.current);};
  },[]);
  function update(change:Partial<ClientWatermarkPolicy>) {
    setProposed(current=>({...current,...change}));
    if(sampleUrl.current){URL.revokeObjectURL(sampleUrl.current);sampleUrl.current="";}
    setSample("");
  }
  function choose(category:ClientWatermarkPolicy["categories"][number],checked:boolean) {
    update({categories:checked?[...proposed.categories,category]:proposed.categories.filter(item=>item!==category)});
  }
  async function apply(mode:"sample"|"save") {
    if(busy)return;
    const controller=new AbortController();
    inFlight.current=controller;
    setError("");
    setBusy(mode);
    try{
      const action=mode==="save"?"watermark":"watermark-sample";
      const response=await fetch(`/api/client-documents/${action}?scope=staff`,{
        method:"POST",cache:"no-store",signal:controller.signal,headers:{"Content-Type":"application/json"},
        body:JSON.stringify({...proposed,case:caseId}),
      });
      if(!response.ok){
        const result=await response.json().catch(()=>null);
        throw new Error(result?.error??"The watermark request could not be completed.");
      }
      if(mode==="save"){
        const result=await response.json();
        onSaved(result.message);
        return;
      }
      const image=await response.blob();
      if(controller.signal.aborted)return;
      if(sampleUrl.current)URL.revokeObjectURL(sampleUrl.current);
      sampleUrl.current=URL.createObjectURL(image);
      setSample(sampleUrl.current);
    }catch(reason){
      if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:"The watermark request could not be completed.");
    }finally{
      if(!controller.signal.aborted)setBusy(null);
    }
  }
  function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();void apply("save");}
  return <dialog ref={dialog} className="client-doc-dialog client-watermark-dialog" aria-label="Client document watermark settings" onCancel={onClose}>
    <header><div><h2>Document watermark</h2><p>Set an organization policy for approved document categories.</p></div><button type="button" className="icon-button" aria-label="Close watermark settings" onClick={onClose}><Icon name="close"/></button></header>
    <form method="post" className="client-doc-decision" onSubmit={submit}>
      <label className="client-doc-check"><input type="checkbox" checked={proposed.enabled} disabled={!!busy} onChange={event=>update({enabled:event.target.checked})}/> Enable watermark on secure preview copies</label>
      <div className="client-watermark-fields">
        <label>Watermark text<input type="text" value={proposed.label} disabled={!!busy} maxLength={110} required onChange={event=>update({label:event.target.value})}/></label>
        <label>Opacity · {proposed.opacity}%<input type="range" min={5} max={80} value={proposed.opacity} aria-label="Watermark opacity" disabled={!!busy} onChange={event=>update({opacity:Number(event.target.value)})}/></label>
        <label>Position<select value={proposed.position} disabled={!!busy} onChange={event=>update({position:event.target.value as ClientWatermarkPolicy["position"]})}><option value="top">Top</option><option value="center">Center</option><option value="bottom">Bottom</option></select></label>
      </div>
      <label className="client-doc-check"><input type="checkbox" checked={proposed.repeat_mark} disabled={!!busy} onChange={event=>update({repeat_mark:event.target.checked})}/> Repeat across the page</label>
      <label className="client-doc-check"><input type="checkbox" checked={proposed.show_client} disabled={!!busy} onChange={event=>update({show_client:event.target.checked})}/> Display masked client identifier</label>
      <label className="client-doc-check"><input type="checkbox" checked={proposed.show_time} disabled={!!busy} onChange={event=>update({show_time:event.target.checked})}/> Display date and time (UTC)</label>
      <fieldset className="client-watermark-categories">
        <legend>Categories covered</legend>
        {clientDocumentCategories.map(category=><label key={category} className="client-doc-check"><input type="checkbox" checked={proposed.categories.includes(category)} disabled={!!busy} onChange={event=>choose(category,event.target.checked)}/> {category}</label>)}
      </fieldset>
      {sample&&<figure className="client-watermark-sample"><img src={sample} alt={proposed.enabled?"Sample document with the proposed watermark":"Sample document with no watermark"}/><figcaption>Sample preview of unsaved settings</figcaption></figure>}
      {error&&<p role="alert" className="form-error">{error}</p>}
      <div className="client-doc-row-actions">
        <button type="button" disabled={!!busy||!proposed.label.trim()} className="btn btn-outline" onClick={()=>void apply("sample")}>{busy==="sample"?"Rendering…":"Preview settings"}</button>
        <button type="submit" className="btn btn-blue" disabled={!!busy}>{busy==="save"?"Saving…":"Save watermark policy"}</button>
      </div>
    </form>
  </dialog>;
}
