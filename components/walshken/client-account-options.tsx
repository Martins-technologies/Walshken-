"use client";
import Link from "next/link";
import {useEffect,useState,type FormEvent} from "react";
import {clientRequest} from "./client-access";
import {clientLocales,clientLocaleNames,type ClientLocale} from "@/lib/walshken/client-locales";

export function ClientAuthenticator(){
  const [factor,setFactor]=useState<{enabled:boolean;recoveryCodesRemaining:number}>(),[setup,setSetup]=useState<string>(),[codes,setCodes]=useState<string[]>();
  const [error,setError]=useState(""),[busy,setBusy]=useState(false);
  useEffect(()=>{void clientRequest<{enabled:boolean;recoveryCodesRemaining:number}>("/api/customer/mfa").then(setFactor).catch(e=>setError(e.message));},[]);
  async function submit(event:FormEvent<HTMLFormElement>,action:string){
    event.preventDefault();
    const form=event.currentTarget;
    setBusy(true);setError("");
    try{
      const data=await clientRequest<{setupKey?:string;recoveryCodes?:string[]}>("/api/customer/"+action,Object.fromEntries(new FormData(form)));
      form.reset();
      if(data.setupKey)setSetup(data.setupKey);
      if(data.recoveryCodes){setCodes(data.recoveryCodes);setSetup(undefined);}
      if(action==="mfa-disable")window.location.assign("/customer/sign-in");
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <section className="client-card">
    <div className="client-card-heading"><div><h2>Two-step verification</h2><p>Use an authenticator app to secure your account.</p></div>{factor&&<span className="client-badge">{factor.enabled?"Enabled":"Off"}</span>}</div>
    {error&&<p className="client-alert" role="alert">{error}</p>}
    {codes?<><p>Save these single-use recovery codes somewhere private. Your other sessions have ended.</p><ul className="client-recovery-codes">{codes.map(code=><li key={code}><code>{code}</code></li>)}</ul><Link className="btn btn-blue" href="/customer/sign-in">Sign in again</Link></>
    :setup?<form key="confirm" method="post" className="client-form" onSubmit={e=>void submit(e,"mfa-confirm")}><p>In your authenticator app, add a time-based account called Walshken and enter this key.</p><p><code dir="ltr">{setup}</code></p>
      <label>Current password<input name="password" type="password" autoComplete="current-password" required/></label><label>Six-digit code<input name="code" maxLength={6} pattern="[0-9]{6}" inputMode="numeric" autoComplete="one-time-code" required/></label>
      <div className="client-form-actions"><button className="btn btn-blue" disabled={busy}>Confirm authenticator</button><button type="button" className="client-text" onClick={()=>setSetup(undefined)}>Cancel setup</button></div></form>
    :factor&&<><form key="setup" className="client-form" method="post" onSubmit={e=>void submit(e,"mfa-setup")}>
      {factor.enabled&&<p className="client-small">{factor.recoveryCodesRemaining} unused recovery codes. Replacing your authenticator generates a new set.</p>}
      <label>Current password<input name="password" type="password" autoComplete="current-password" required/></label>
      {factor.enabled&&<label>Current authenticator or recovery code<input name="code" autoComplete="one-time-code" maxLength={24} required/></label>}
      <div><button className="btn btn-blue" disabled={busy}>{factor.enabled?"Replace authenticator":"Set up authenticator"}</button></div>
    </form>{factor.enabled&&<details className="client-disclosure client-mfa-disable"><summary>Turn off two-step verification</summary><form method="post" className="client-form" onSubmit={e=>void submit(e,"mfa-disable")}>
      <label>Current password<input name="password" type="password" autoComplete="current-password" required/></label>
      <label>Authenticator or recovery code<input name="code" autoComplete="one-time-code" maxLength={24} required/></label>
      <div><button className="btn btn-outline" disabled={busy}>Turn off and sign out</button></div>
    </form></details>}</>}
  </section>;
}

export function ClientLanguagePolicy(){
  const [enabled,setEnabled]=useState<ClientLocale[]>(),[message,setMessage]=useState(""),[error,setError]=useState(""),[saving,setSaving]=useState(false);
  useEffect(()=>{void clientRequest<{enabled:ClientLocale[]}>("/api/customer/language-policy").then(result=>setEnabled(result.enabled)).catch(e=>setError(e.message));},[]);
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(!enabled)return;
    setSaving(true);setMessage("");setError("");
    try{const result=await clientRequest<{enabled:ClientLocale[]}>("/api/customer/language-policy",{enabled});setEnabled(result.enabled);setMessage("Portal languages saved.");}
    catch(e){setError((e as Error).message);}finally{setSaving(false);}
  }
  return <section className="panel"><h3>Client Portal languages</h3><p>Clients can choose an enabled interface language. Agreements and official records use their issued language.</p>
    {error&&<p className="form-error" role="alert">{error}</p>}{message&&<p className="form-success" role="status">{message}</p>}
    {enabled&&<form method="post" onSubmit={save} className="ws-form">
      <fieldset><legend>Available languages</legend>{clientLocales.map(locale=><label key={locale}><input type="checkbox" checked={enabled.includes(locale)} disabled={locale==="en"||saving} onChange={e=>setEnabled(e.target.checked?[...enabled,locale]:enabled.filter(item=>item!==locale))}/> <span lang={locale}>{clientLocaleNames[locale]}</span></label>)}</fieldset>
      <button className="btn btn-blue btn-small" disabled={saving}>Save languages</button>
    </form>}
  </section>;
}

export function ClientAccessControls({customerId}:{customerId:string}){
  const [data,setData]=useState<{suspended:boolean;canRestore:boolean;records:{id:string;action:string;reason:string;reviewer:string;created_at:string}[]}>();
  const [error,setError]=useState(""),[busy,setBusy]=useState(false);
  async function load(){
    setError("");
    try{setData(await clientRequest<NonNullable<typeof data>>("/api/customer/account-access?id="+encodeURIComponent(customerId)));}
    catch(e){setError((e as Error).message);}
  }
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!data)return;
    const form=event.currentTarget;
    setBusy(true);setError("");
    try{
      await clientRequest("/api/customer/account-access",{id:customerId,action:data.suspended?"Restored":"Suspended",reason:new FormData(form).get("reason")});
      form.reset();
      await load();
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <details onToggle={e=>{if(e.currentTarget.open&&!data)void load();}}>
    <summary>Client account access</summary>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {data&&<><p>{data.suspended?"Account suspended":"Account active"}</p>
      {(!data.suspended||data.canRestore)&&<form method="post" className="client-form" onSubmit={save}>
        <label>Reason for this decision<textarea name="reason" rows={2} required maxLength={1000}/></label>
        <div><button className="btn btn-outline btn-small" disabled={busy}>{data.suspended?"Restore sign-in":"Suspend sign-in and revoke sessions"}</button></div>
      </form>}
      {data.records.length>0&&<ul className="client-list">{data.records.map(record=><li key={record.id}><div><strong>{record.action} · {record.reviewer}</strong><p>{record.reason}</p></div><small>{new Date(record.created_at).toLocaleString()}</small></li>)}</ul>}
    </>}
  </details>;
}
