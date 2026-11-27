"use client";

import { useEffect,useRef,useState,type PointerEvent } from "react";
import { cropScan,detectScanFrame,exportScan,loadScanImage,rotateScan,type ScanQuad } from "@/lib/walshken/client-document-scan";
import { Icon } from "./brand";

export function ClientDocumentCamera({file,done,close}:{file:File;done:(file:File)=>void;close:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null),frame=useRef<HTMLDivElement>(null),display=useRef<HTMLCanvasElement>(null);
  const active=useRef<number|null>(null);
  const [source,setSource]=useState<HTMLCanvasElement|null>(null),[quad,setQuad]=useState<ScanQuad|null>(null),[preview,setPreview]=useState<HTMLCanvasElement|null>(null);
  const [format,setFormat]=useState<"pdf"|"jpeg">("pdf"),[enhance,setEnhance]=useState(true),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  useEffect(()=>{
    const current=dialog.current;
    current?.showModal();
    return()=>current?.close();
  },[]);
  useEffect(()=>{
    let live=true;
    void loadScanImage(file).then(image=>{if(live){setSource(image);setQuad(detectScanFrame(image));}},reason=>{if(live)setError(reason.message||"This photo could not be opened.");});
    return()=>{live=false;};
  },[file]);
  useEffect(()=>{
    const image=preview??source,canvas=display.current;
    if(!image||!canvas)return;
    canvas.width=image.width;canvas.height=image.height;canvas.getContext("2d")!.drawImage(image,0,0);
  },[source,preview]);
  function move(index:number,x:number,y:number){
    setQuad(current=>current?current.map((p,i)=>i===index?{x:Math.max(0,Math.min(1,x)),y:Math.max(0,Math.min(1,y))}:p) as ScanQuad:current);
    setPreview(null);
  }
  function position(event:PointerEvent<HTMLButtonElement>,index:number){
    const rect=frame.current?.getBoundingClientRect();
    if(rect)move(index,(event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height);
  }
  function prepare(){
    if(!source||!quad)return;
    try{setError("");setPreview(cropScan(source,quad,enhance));}
    catch(reason){setError(reason instanceof Error?reason.message:"The scan could not be cropped.");}
  }
  async function save(){
    if(!preview||busy)return;
    setBusy(true);
    try{done(await exportScan(preview,format));}
    catch(reason){setError(reason instanceof Error?reason.message:"The scan could not be saved.");}
    finally{setBusy(false);}
  }
  return <dialog ref={dialog} className="client-doc-dialog client-scan-dialog" aria-label="Prepare a document scan" onCancel={close}>
    <header><div><h2>Prepare your scan</h2><p>{preview?"Check the corrected scan before adding it to your upload.":"Move the four corners to match the edges of your page."}</p></div><button type="button" className="icon-button" aria-label="Close scan" onClick={close}><Icon name="close"/></button></header>
    {!source&&!error&&<p role="status">Opening the photo…</p>}
    {source&&quad&&<div ref={frame} className="client-scan-frame">
      <canvas ref={display} aria-label={preview?"Corrected scan preview":"Photo to crop"}/>
      {!preview&&<><span className="client-scan-shade" style={{clipPath:`polygon(${quad.map(p=>`${p.x*100}% ${p.y*100}%`).join(",")})`}}/>
        {quad.map((p,i)=><button key={i} type="button" className="client-scan-corner" style={{left:`${p.x*100}%`,top:`${p.y*100}%`}}
          aria-label={["Top-left corner","Top-right corner","Bottom-right corner","Bottom-left corner"][i]}
          onPointerDown={event=>{active.current=i;event.currentTarget.setPointerCapture(event.pointerId);position(event,i);}}
          onPointerMove={event=>{if(active.current===i)position(event,i);}}
          onPointerUp={()=>{active.current=null;}} onPointerCancel={()=>{active.current=null;}}
          onKeyDown={event=>{const arrows:Record<string,[number,number]>={ArrowLeft:[-.015,0],ArrowRight:[.015,0],ArrowUp:[0,-.015],ArrowDown:[0,.015]};const delta=arrows[event.key];if(delta){event.preventDefault();move(i,p.x+delta[0],p.y+delta[1]);}}}/>)}</>}
    </div>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    {source&&<footer>
      {preview?<><label>Save as <select value={format} onChange={event=>setFormat(event.target.value as "pdf"|"jpeg")}><option value="pdf">PDF</option><option value="jpeg">JPEG</option></select></label><button type="button" className="btn btn-outline" onClick={()=>setPreview(null)}>Adjust crop</button><button type="button" className="btn btn-blue" disabled={busy} onClick={()=>void save()}>{busy?"Preparing…":"Add scan"}</button></>:
      <><button type="button" className="btn btn-outline btn-small" onClick={()=>{setSource(rotateScan(source));setQuad(current=>current?[current[3],current[0],current[1],current[2]].map(p=>({x:1-p.y,y:p.x})) as ScanQuad:current);}}>Rotate</button>
        <button type="button" className="btn btn-outline btn-small" onClick={()=>setQuad(detectScanFrame(source))}>Detect edges</button>
        <label><input type="checkbox" checked={enhance} onChange={event=>setEnhance(event.target.checked)}/> Enhance contrast</label>
        <button type="button" className="btn btn-blue" onClick={prepare}>Preview scan</button></>}
    </footer>}
  </dialog>;
}
