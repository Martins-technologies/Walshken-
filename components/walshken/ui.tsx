"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "./brand";

export type RecordRow = Record<string, string | number | null>;
export type ResponseData = { ok?: boolean; message?: string; code?: string; error?: string; id?: string; url?: string };
export type Field = {
  preserveLocalValue?: boolean;
  name: string; label: string; type?: string; options?: readonly (string | readonly [string,string])[];
  value?: string | number | null; placeholder?: string; required?: boolean; min?: number; max?: number; multiple?: boolean; autoComplete?: string; accept?:string;
};
export const value = (row:RecordRow|undefined,key:string) => String(row?.[key] ?? "");
export const initials = (name:string) => name.split(/\s+/).slice(0,2).map((part)=>part[0]?.toUpperCase()).join("") || "W";
export function dateText(raw:string|number|null|undefined,includeTime=false,zone?:string){
  if(typeof raw!=="string"||!raw) return "—";
  const dateOnly=/^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed=new Date(dateOnly?raw+"T12:00:00Z":raw);
  if(Number.isNaN(parsed.valueOf()))return "—";
  return new Intl.DateTimeFormat("en-CA",{month:"short",day:"numeric",year:"numeric",...(includeTime&&!dateOnly?{hour:"numeric",minute:"2-digit",timeZoneName:"short"}:{}),timeZone:dateOnly?"UTC":zone}).format(parsed);
}
export const hours = (seconds:unknown) => `${(Number(seconds||0)/3600).toFixed(2)} h`;
export const money = (cents:unknown,currency:string) => new Intl.NumberFormat("en-CA",{style:"currency",currency:currency||"CAD"}).format(Number(cents||0)/100);
export const options = (rows:RecordRow[],key="name") => rows.map((row)=>[value(row,"id"),value(row,key)] as const);
export function Status({ children }: { children:ReactNode }){
  const label=String(children??"");
  const tone=/\b(Suspended|Declined|Revoked|Overdue|Cancelled|Failed|Blocked)\b/i.test(label)?" bad":/\b(Approved|Active|Completed|Reviewed|Enabled|Available|Paid|Published)\b/i.test(label)?" good":/\b(Pending|Review|Submitted|Estimate|Soon|Break|Waiting)\b/i.test(label)?" warn":"";
  return <span className={`status-tag${tone}`}>{children}</span>;
}
export function Empty({title="Nothing to show yet",body="Records will appear here as your workspace is used.",icon="layout"}:{title?:string;body?:string;icon?:string}){
  return <div className="empty"><span className="icon-tile"><Icon name={icon} size={21}/></span><strong>{title}</strong><p>{body}</p></div>;
}
export function Panel({ title, note, action, children, className="" }:{title:string;note?:string;action?:ReactNode;children:ReactNode;className?:string}){
  return <section className={`staff-panel ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{note&&<p>{note}</p>}</div>{action}</div>{children}</section>;
}
export function Table({ columns, rows, empty, actions }:{
  columns:{key:string;title:string;render?:(row:RecordRow)=>ReactNode}[];
  rows:RecordRow[];empty?:string;actions?:(row:RecordRow)=>ReactNode;
}){
  const scroll=useRef<HTMLDivElement>(null),table=useRef<HTMLTableElement>(null);
  const [overflow,setOverflow]=useState(false);
  const hasRows=rows.length>0;
  useEffect(()=>{
    if(!scroll.current||!table.current)return;
    const root=scroll.current;
    const measure=()=>setOverflow(root.scrollWidth>root.clientWidth+1);
    const observer=new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(table.current);
    measure();
    return ()=>observer.disconnect();
  },[hasRows]);
  if(!rows.length) return <Empty title={empty??"No records yet"} icon="list"/>;
  return <div ref={scroll} className="table-scroll" tabIndex={overflow?0:undefined} role={overflow?"region":undefined} aria-label={overflow?`${columns[0]?.title??"Workspace"} table, scroll for more columns`:undefined}><table ref={table} className="staff-table"><thead><tr>{columns.map((c)=><th key={c.key} scope="col">{c.title}</th>)}{actions&&<th scope="col">Actions</th>}</tr></thead><tbody>
    {rows.map((row,index)=><tr key={value(row,"id")||index}>{columns.map((c)=><td key={c.key}>{c.render?c.render(row):row[c.key]??"—"}</td>)}
      {actions&&<td><div className="row-actions">{actions(row)}</div></td>}</tr>)}</tbody></table></div>;
}
export async function api(path:string,data?:Record<string,unknown>|FormData,signal?:AbortSignal){
  const endpoint=path.startsWith('payroll/')?`/api/${path}`:`/api/workspace/${path}`;
  const response=await fetch(endpoint,data===undefined?{cache:"no-store",signal}:data instanceof FormData
    ?{method:"POST",body:data}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
  const result=await response.json().catch(()=>({error:"The server did not return a usable response."}));
  if(!response.ok) throw new Error(result.error||"This action could not be completed.");
  return result;
}
export function FieldInput({field}:{field:Field}){
  if(field.type==="checkbox")return <label className="staff-check-field"><input name={field.name} type="checkbox" required={field.required} defaultChecked={field.value==="1"||field.value===1}/><span>{field.label}</span></label>;
  return <label className={field.type==="textarea"?"field-wide":undefined}>{field.label}
    {field.options ? <select name={field.name} required={field.required} multiple={field.multiple}
      defaultValue={field.multiple?[]:String(field.value??"")} size={field.multiple?4:undefined}>
      {!field.multiple&&<option value="">Choose…</option>}
      {field.options.map((item)=>{const [key,label]=typeof item==="string"?[item,item]:item;return <option key={key} value={key}>{label}</option>;})}</select>
    :field.type==="textarea"?<textarea name={field.name} rows={3} defaultValue={String(field.value??"")} required={field.required} placeholder={field.placeholder} maxLength={field.max??3000}/>
    :<input name={field.name} type={field.type??"text"} required={field.required} defaultValue={field.value==null?undefined:field.value}
      step={field.type==="number"?"any":undefined} min={field.type==="number"?field.min:undefined} minLength={field.type==="password"?field.min:undefined} max={field.type==="number"?field.max:undefined} maxLength={field.type==="number"?undefined:field.max}
      placeholder={field.placeholder} accept={field.accept} autoComplete={field.autoComplete ?? (field.type==="password"?"new-password":undefined)}/>}
  </label>;
}
export function ActionForm({path,fields,submit,refresh,extra={},file=false,onDone,reset=true}:{
  path:string;fields:Field[];submit:string;refresh?:()=>void;extra?:Record<string,unknown>;file?:boolean;onDone?:(data:ResponseData)=>void;reset?:boolean;
}){
  const [busy,setBusy]=useState(false),[status,setStatus]=useState(""),[code,setCode]=useState(""),[error,setError]=useState(false);
  async function send(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(busy)return;
    const form=event.currentTarget, formData=new FormData(form);
    setBusy(true);setStatus("");setCode("");setError(false);
    try{
      const data:Record<string,unknown>={...Object.fromEntries(formData),...extra};
      for(const field of fields) if(field.type==="checkbox") data[field.name]=formData.has(field.name);
      for(const field of fields) if(field.multiple) data[field.name]=formData.getAll(field.name);
      for(const field of fields) if(field.type==="datetime-local"&&!field.preserveLocalValue&&data[field.name]) data[field.name]=new Date(String(data[field.name])).toISOString();
      const result=await api(path,file?formData:data) as ResponseData;
      if(reset) form.reset();
      setStatus(result.message??"Saved.");setCode(result.code??"");refresh?.();onDone?.(result);
    }catch(e){setError(true);setStatus(e instanceof Error?e.message:"Please try again.");}
    finally{setBusy(false);}
  }
  return <form className="staff-form" method="post" aria-busy={busy||undefined} onSubmit={send}>
    <div className="staff-fields">{fields.map((field)=><FieldInput key={field.name} field={field}/>)}</div>
    <button className="btn btn-blue btn-small" disabled={busy}>{busy?"Working…":submit}</button>
    {status&&<p className={error?"form-error":"form-success"} role={error?"alert":"status"}><Icon name={error?"alert":"success"} size={16}/>{status}</p>}
    {code&&<div className="access-code"><strong>One-time code</strong><code>{code}</code><small>Share privately with the employee. This code is shown once.</small></div>}
  </form>;
}
export function Quick({path,data={},children,refresh,variant="outline",onDone}:{
  path:string;data?:Record<string,unknown>;children:ReactNode;refresh?:()=>void;variant?:string;onDone?:(data:ResponseData)=>void;
}){
  const [error,setError]=useState(""),[busy,setBusy]=useState(false);
  async function click(){
    setBusy(true);setError("");
    try{const result=await api(path,data);refresh?.();onDone?.(result);}
    catch(e){setError(e instanceof Error?e.message:"Please try again.");}
    finally{setBusy(false);}
  }
  return <span className="quick-action"><button type="button" className={`btn btn-${variant} btn-small`} disabled={busy} onClick={click}>{busy?"Working…":children}</button>
    {error&&<small className="form-error" role="alert">{error}</small>}</span>;
}
export function Disclosure({title,children}:{title:string;children:ReactNode}){
  return <details className="disclosure"><summary><Icon name="plus" size={16}/>{title}</summary><div>{children}</div></details>;
}
