"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./brand";

type Entry = readonly [key:string, label:string, icon:string];
const keywords: Record<string,string> = {
  attendance:"clock in clock out break", shifts:"schedule roster", salary:"pay wages payslip",
  employees:"staff people invite onboarding", departments:"teams divisions offices", reports:"ranking staff performance",
  messages:"chat direct conversations", calls:"video audio meeting", documents:"files library", integrations:"providers connection",
};

export function WorkspaceSearch({entries,section,href,onClose}:{
  entries:readonly Entry[]; section:string; href:(key:string)=>string; onClose:()=>void;
}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const input=useRef<HTMLInputElement>(null);
  const id=useId();
  const [query,setQuery]=useState("");
  const [active,setActive]=useState(0);
  const search=query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches=entries.filter(([key,label])=>search.every(word=>`${label} ${key} ${keywords[key]??""}`.toLowerCase().includes(word)));

  useEffect(()=>{
    const modal=dialog.current;
    const previous=document.activeElement;
    modal?.showModal();
    input.current?.focus();
    return ()=>{modal?.close();if(previous instanceof HTMLElement)previous.focus();};
  },[]);
  useEffect(()=>{
    document.getElementById(`${id}-${active}`)?.scrollIntoView({block:"nearest",behavior:"instant"});
  },[active,id]);

  return <dialog ref={dialog} className="workspace-search-dialog" aria-labelledby={`${id}-title`}
    onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget)onClose();}}>
    <div className="workspace-search-inner">
      <header><h2 id={`${id}-title`}>Find a page</h2><button type="button" onClick={onClose} className="icon-button" aria-label="Close search"><Icon name="close" size={19}/></button></header>
      <label className="workspace-search-input"><Icon name="search" size={19}/>
        <span className="sr-only">Search workspace pages</span>
        <input ref={input} value={query} placeholder="Search workspace pages" onChange={event=>{setQuery(event.target.value);setActive(0);}}
          onKeyDown={event=>{
            if(!matches.length)return;
            if(event.key==="ArrowDown"||event.key==="ArrowUp"){
              event.preventDefault();
              setActive(previous=>(previous+(event.key==="ArrowDown"?1:matches.length-1))%matches.length);
            }
            if(event.key==="Enter"){event.preventDefault();window.location.assign(href(matches[active][0]));}
          }}/>
      </label>
      <p className="sr-only" role="status">{matches.length} {matches.length===1?"page":"pages"}</p>
      {matches.length?<ul className="workspace-search-results">{matches.map(([key,label,icon],index)=><li key={key}><a id={`${id}-${index}`} href={href(key)} aria-current={key===section?"page":undefined} className={index===active?"selected":undefined} onMouseEnter={()=>setActive(index)}><Icon name={icon} size={17}/><span>{label}</span><Icon name="right" size={15}/></a></li>)}</ul>
        :<p className="workspace-search-empty">No pages match “{query.trim()}”.</p>}
    </div>
  </dialog>;
}
