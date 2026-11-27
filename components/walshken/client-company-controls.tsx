"use client";

import {useEffect,useRef,useState,type FormEvent} from "react";
import {Icon} from "./brand";
import styles from "./client-company-controls.module.css";

type Snapshot = {profile:Record<string,string|string[]>;version:number;verifiedFields:string[]};
const labels:Record<string,string> = {
  name:"Full legal name",email:"Verified email address",dob:"Date of birth",phone:"Phone number",address:"Residential address",
  countryOfBirth:"Country of birth",countryOfResidence:"Country of residence",citizenships:"Citizenships",passportNumber:"Passport number",
  passportCountry:"Passport issuing country",immigrationHistory:"Immigration history",immigrationStatus:"Immigration status",
  language:"Preferred language",emergencyName:"Emergency contact",emergencyPhone:"Emergency contact phone",
};

async function companyRequest<T>(path:string,body?:Record<string,unknown>):Promise<T>{
  const response=await fetch(`/api/customer/${path}`,{cache:"no-store",...(body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{})});
  const result=await response.json().catch(()=>null);
  if(!response.ok||!result)throw new Error(result?.error??"The request could not be completed.");
  return result;
}

export function ClientCompanyControls({customerId,caseId}:{customerId:string;caseId?:string}){
  const [review,setReview]=useState<{customerId:string;profile:Snapshot}|null>(null);
  const [fields,setFields]=useState<string[]>([]),[reason,setReason]=useState("");
  const [busy,setBusy]=useState(""),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const sendReference=useRef<string|null>(null);
  const profile=review?.customerId===customerId?review.profile:null;
  useEffect(()=>{
    const hide=()=>{if(document.hidden){setReview(null);setFields([]);setReason("");}};
    document.addEventListener("visibilitychange",hide);
    return()=>document.removeEventListener("visibilitychange",hide);
  },[]);
  useEffect(()=>{sendReference.current=null;setNotice("");setError("");},[customerId,caseId]);

  async function load(){
    setBusy("load");setError("");setNotice("");
    try {
      const data=await companyRequest<Snapshot>(`profile-verification?id=${encodeURIComponent(customerId)}`);
      if(document.hidden)return;
      setFields(data.verifiedFields.filter(field=>field!=="email"));
      setReview({customerId,profile:data});
    } catch(problem){setError((problem as Error).message);}
    finally{setBusy("");}
  }
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!profile||busy)return;
    setBusy("profile");setError("");setNotice("");
    try {
      const result=await companyRequest<{version:number}>("profile-verification",{id:customerId,version:profile.version,fields,reason});
      if(!document.hidden)setReview({customerId,profile:{...profile,version:result.version,verifiedFields:["email",...fields]}});
      setReason("");setNotice("Profile verification saved.");
    } catch(problem){setError((problem as Error).message);}
    finally{setBusy("");}
  }
  async function publish(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return;
    const form=event.currentTarget,data=new FormData(form);
    const reference=sendReference.current??crypto.randomUUID();
    sendReference.current=reference;
    setBusy("announcement");setNotice("");setError("");
    try{
      const result=await companyRequest<{message:string}>("announcement",{
        id:customerId,case:data.get("scope")==="case"?caseId:undefined,
        title:data.get("title"),body:data.get("body"),reference,
      });
      form.reset();sendReference.current=null;setNotice(result.message);
    }catch(problem){setError((problem as Error).message);}
    finally{setBusy("");}
  }

  return <section className={styles.panel} aria-labelledby={`client-controls-${customerId}`}>
    <h3 id={`client-controls-${customerId}`}><Icon name="shield" size={18}/> Client identity & announcements</h3>
    {error&&<p className={styles.error} role="alert">{error}</p>}
    {notice&&<p className={styles.success} role="status">{notice}</p>}
    <details className={styles.disclosure} onToggle={event=>{if(!event.currentTarget.open){setReview(null);setReason("");}}}>
      <summary>Verify client profile fields</summary>
      <p>Review information against approved evidence. Verified fields require an authorized correction before the client can edit them.</p>
      {!profile?<button className="btn btn-outline btn-small" type="button" disabled={!!busy} onClick={()=>void load()}>{busy==="load"?"Loading…":"Open profile for verification"}</button>:
        <form method="post" className={styles.form} onSubmit={save}>
          <div className={styles.fields}>
            {Object.entries(labels).filter(([field])=>profile.profile[field]?.length).map(([field,label])=><label key={field} className={styles.choice}>
              <input type="checkbox" checked={field==="email"||fields.includes(field)} disabled={field==="email"||!!busy}
                onChange={event=>setFields(current=>event.target.checked?[...current,field]:current.filter(key=>key!==field))}/>
              <span><strong>{label}</strong><span className={styles.value}>{Array.isArray(profile.profile[field])?profile.profile[field].join(", "):profile.profile[field]}</span></span>
            </label>)}
          </div>
          <label>Verification evidence or correction reason<textarea rows={2} maxLength={500} required value={reason} onChange={event=>setReason(event.target.value)}/></label>
          <div><button className="btn btn-blue btn-small" type="submit" disabled={!!busy}>{busy==="profile"?"Saving…":"Save verified fields"}</button></div>
        </form>}
    </details>
    <details className={styles.disclosure}>
      <summary>Publish a client announcement</summary>
      <p>The selected client will see this message in their portal. Optional email alerts include a sign-in link without the announcement text.</p>
      <form method="post" className={styles.form} key={customerId+caseId} onSubmit={publish}>
        {caseId&&<label>Link to the case or notification center<select name="scope" defaultValue="case"><option value="case">This case</option><option value="client">Client notification center</option></select></label>}
        <label>Title<input name="title" required maxLength={150}/></label>
        <label>Client-facing message<textarea name="body" maxLength={600} rows={4} required/></label>
        <div><button className="btn btn-blue btn-small" type="submit" disabled={!!busy}>{busy==="announcement"?"Publishing…":"Publish announcement"}</button></div>
      </form>
    </details>
  </section>;
}
