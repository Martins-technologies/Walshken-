"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminNav, roleNames, staffNav, type Role } from "@/lib/walshken/catalog";
import { Brand, Icon } from "./brand";
import { api, initials } from "./ui";
import { WorkspaceViews, type ViewData } from "./workspace-views";
import { AdminViews } from "./workspace-admin";
import { WorkspaceSearch } from "./workspace-search";
import "./staff-portal.css";

export type Viewer = {id:string;name:string;role:Role;timeZone:string;employeeNo:string};
const links: readonly (readonly [string,string,string])[] = [...staffNav.flatMap<readonly [string,string,string]>((group)=>group.items),...adminNav];
const notes:Record<string,string>={
  messages:"Keep conversations with your authorized teammates in one place.",
  calls:"Schedule private meetings and join authorized rooms.",
  tasks:"Track priorities, progress and review.",
  projects:"See the workstreams you’re part of.",
  calendar:"See shifts, deadlines, meetings and approved leave together.",
  attendance:"Record your working time and breaks.",
  shifts:"View your published work schedule.",
  timesheets:"Review your hours and submit them for approval.",
  salary:"View your own approved payroll records.",
  leave:"Request time off and follow decisions.",
  documents:"Upload and share files with permitted colleagues.",
  directory:"Find teammates in your workspace scope.",
  notifications:"Keep up with assignments, decisions and schedule updates.",
  privacy:"Request authorized personal-data exports and manage retained archive copies.",
  profile:"Review your employment record and recent sessions.",
  employees:"Manage staff access and onboarding.",
  departments:"Set up divisions, departments and offices.",
  roles:"Control staff access using scoped role assignments.",
  scheduling:"Publish shifts for employees in your scope.",
  approvals:"Review submitted time and attendance corrections.",
  payroll:"Manage effective pay rates, statutory calculations, approvals and recorded payments.",
  holidays:"Manage applicable holidays, verified entitlements and effective employment rules.",
  "holiday-calendar":"Your assigned holidays, reviewed entitlement and paid-day arrangements.",
  reports:"Review team activity across work, attendance and approvals.",
  "document-security":"Review private documents and revoke access.",
  audit:"Search append-only administrative and access events.",
  website:"Manage the public catalog, homepage and incoming inquiries.",
  countries:"Control markets and publish approved service destinations.",
  integrations:"Add provider credentials as services are ready to connect.",
  governance:"Manage workplace policies, retention and security controls.",
};
const href=(section:string)=>section==="dashboard"?"/staff":`/staff/${section}`;
const groups = [...staffNav, {title:"Administration", items:adminNav}];
const mobileNavigation = "(max-width: 1020px)";

export function Workspace({section,allowed,actor}:{section:string;allowed:readonly string[];actor:Viewer}){
  const initialKeys = section === "calendar" ? ["mode","view","anchor","from","to","department","country","employee","team","types"]
    : ["shifts","scheduling","approvals","leave"].includes(section) ? ["from","to","team","exceptions"]
      : ["payroll","salary"].includes(section) ? ["period"]
      : section === "projects" ? ["q","status","order","page","project"] : [];
  const [drawer,setDrawer]=useState(false),[search,setSearch]=useState(false),[signingOut,setSigningOut]=useState(false);
  const aside=useRef<HTMLElement>(null),menuButton=useRef<HTMLButtonElement>(null),closeButton=useRef<HTMLButtonElement>(null);
  const navList=useRef<HTMLElement>(null);
  const [data,setData]=useState<ViewData|null>(null),[error,setError]=useState(""),[query,setQuery]=useState(()=>{
    const params=new URLSearchParams(typeof window==="undefined"?"":window.location.search);
    return new URLSearchParams([...params].filter(([key])=>initialKeys.includes(key))).toString();
  });
  const [version,setVersion]=useState(0);
  const refresh=useCallback(()=>setVersion((current)=>current+1),[]);
  const nav=links.find((item)=>item[0]===section);
  const isDashboard=section==="dashboard";
  const isAdminSection=adminNav.some(([key])=>key===section);
  const canProfile=allowed.includes("profile"),canNotify=allowed.includes("notifications");
  const closeDrawer=useCallback(()=>{setDrawer(false);requestAnimationFrame(()=>menuButton.current?.focus());},[]);
  useEffect(()=>{
    const controller=new AbortController();
    api(`view/${section}${query?`?${query}`:""}`,undefined,controller.signal).then((result)=>{
      if(!controller.signal.aborted){setData(result);setError("");}
    },(reason)=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:"Unable to load workspace.");});
    return ()=>controller.abort();
  },[section,version,query]);
  useEffect(()=>{
    const current = navList.current?.querySelector<HTMLAnchorElement>('[aria-current="page"]');
    const list = navList.current;
    if(current&&list&&current.offsetTop+current.offsetHeight>list.scrollTop+list.clientHeight)list.scrollTop=current.offsetTop-32;
  },[section]);
  useEffect(()=>{
    if(!drawer)return;
    const media=window.matchMedia(mobileNavigation);
    const onResize=()=>{if(!media.matches)setDrawer(false);};
    const onKey=(event:KeyboardEvent)=>{
      if (event.key==="Escape") {event.preventDefault();closeDrawer();return;}
      if (event.key!=="Tab") return;
      const targets=aside.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled)');
      if(!targets?.length)return;
      const first=targets[0],last=targets[targets.length-1];
      if(!aside.current?.contains(document.activeElement)){event.preventDefault();(event.shiftKey?last:first).focus();return;}
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    };
    media.addEventListener("change",onResize);
    document.addEventListener("keydown",onKey);
    const previousOverflow=document.body.style.overflow;
    document.body.style.overflow="hidden";
    const focusFrame=requestAnimationFrame(()=>closeButton.current?.focus());
    return ()=>{cancelAnimationFrame(focusFrame);media.removeEventListener("change",onResize);document.removeEventListener("keydown",onKey);document.body.style.overflow=previousOverflow;};
  },[drawer,closeDrawer]);
  useEffect(()=>{
    if(drawer||allowed.length<2)return;
    const onKey=(event:KeyboardEvent)=>{
      if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="k"&&!document.querySelector("dialog[open]:not(.workspace-search-dialog)")) {event.preventDefault();setSearch(open=>!open);}
    };
    document.addEventListener("keydown",onKey);
    return ()=>document.removeEventListener("keydown",onKey);
  },[drawer,allowed.length]);
  async function logout(){
    setSigningOut(true);
    try{await api("session/logout",{});window.location.assign("/staff");}
    catch(e){setSigningOut(false);if(drawer)closeDrawer();setError(e instanceof Error?e.message:"Sign out could not be completed.");}
  }
  return <div className="workspace staff-premium">
    <a className="skip-link" href="#staff-main">Skip to workspace content</a>
    {drawer&&<div className="drawer-scrim" onClick={closeDrawer} aria-hidden="true"/>}
    <aside ref={aside} id="staff-navigation" role={drawer?"dialog":undefined} aria-modal={drawer||undefined} aria-label={drawer?"Workspace menu":undefined} className={drawer?"staff-sidebar open":"staff-sidebar"}>
      <div className="staff-brand"><Brand href={href(allowed.includes("dashboard")?"dashboard":"profile")} compact/><button ref={closeButton} type="button" className="icon-button drawer-close" aria-label="Close menu" onClick={closeDrawer}><Icon name="close"/></button></div>
      <nav ref={navList} className="staff-nav" aria-label="Workspace navigation">
        {groups.map(({title,items})=>{
          const visible=items.filter(([key])=>allowed.includes(key));
          return visible.length>0&&<div className="staff-nav-group" key={title}><div className="nav-label">{title}</div>{visible.map(([key,name,icon])=><a key={key} href={href(key)} aria-current={section===key?"page":undefined} className={section===key?"active":""}><Icon name={icon} size={17}/><span>{name}</span></a>)}</div>;
        })}
      </nav>
      <div className="staff-account"><a href={href("profile")} className="staff-account-profile"><span className="avatar" aria-hidden="true">{initials(actor.name)}</span><span><strong>{actor.name}</strong><small>{roleNames[actor.role]}</small></span></a>
        <button className="icon-button" aria-label={signingOut?"Signing out":"Sign out"} title="Sign out" type="button" disabled={signingOut} onClick={logout}><Icon name="logout" size={17}/></button></div>
    </aside>
    <div className="workspace-body" inert={drawer||undefined}>
      <header className="workspace-bar"><div className="workspace-path"><button ref={menuButton} type="button" className="icon-button staff-menu" aria-label="Open workspace menu" aria-controls="staff-navigation" aria-expanded={drawer} onClick={()=>setDrawer(true)}><Icon name="menu"/></button>
        {allowed.includes("dashboard")&&!isDashboard&&<><a href={href("dashboard")}>Workspace</a><Icon name="next" size={14}/></>}<strong>{nav?.[1]??"Overview"}</strong></div>
        <div className="workspace-utilities">
          {allowed.length>1&&<button className="workspace-search-button" type="button" aria-label="Find a page" onClick={()=>setSearch(true)}><Icon name="search" size={17}/><span>Find a page</span><kbd aria-hidden="true">⌘ / Ctrl K</kbd></button>}
          <a className="corporate-return" href="/">Corporate site <Icon name="external" size={14}/></a>
          {canNotify&&<a href={href("notifications")} className="icon-button" aria-label="Notifications" title="Notifications"><Icon name="bell" size={18}/></a>}
          {canProfile&&<a href={href("profile")} className="avatar avatar-small" aria-label="My profile" title="My profile">{initials(actor.name)}</a>}
        </div></header>
      <main className="workspace-main" id="staff-main" tabIndex={-1}>
        <div className="workspace-title"><div>
          <h1>{isDashboard?`Welcome, ${actor.name.trim().split(/\s+/)[0]}`:nav?.[1]}</h1>{notes[section]&&<p>{notes[section]}</p>}</div>
          {isDashboard&&<time className="workspace-date"><Icon name="calendar" size={16}/>{new Intl.DateTimeFormat("en-CA",{dateStyle:"full",timeZone:actor.timeZone}).format(new Date())}</time>}</div>
        {error&&<div className="workspace-alert" role="alert"><Icon name="alert" size={19}/><span>{error}</span><button type="button" className="btn btn-outline btn-small" onClick={()=>{setError("");refresh();}}>Try again</button></div>}
        {!data&&!error&&<div className="workspace-loading" role="status"><span className="sr-only">Loading {nav?.[1]??"workspace"}</span><div aria-hidden="true"/><div aria-hidden="true"/><div aria-hidden="true"/></div>}
        {data&&(isAdminSection?<AdminViews section={section} actor={actor} data={data} refresh={refresh} setQuery={setQuery}/>
            :<WorkspaceViews section={section} actor={actor} allowed={allowed} data={data} refresh={refresh} setQuery={setQuery}/>)}
      </main>
    </div>
    {search&&<WorkspaceSearch entries={links.filter(([key])=>allowed.includes(key))} section={section} href={href} onClose={()=>setSearch(false)}/>}
  </div>;
}
