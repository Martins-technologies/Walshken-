'use client';
import {useState,type FormEvent} from 'react';
import {ActionForm,Disclosure,Panel,Table,api,type RecordRow} from './ui';
export type SourceDisposalData={sourceDisposals?:RecordRow[];sourceItems?:RecordRow[];sourceEvents?:RecordRow[]};
export function SourceDisposals({data,staff,categories,actorId,refresh}:{data:SourceDisposalData;staff:RecordRow[];categories:readonly string[];actorId:string;refresh:()=>void}){
 const [preview,setPreview]=useState<{manifestHash:string;manifestTime:string;message:string}|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 async function submit(event:FormEvent<HTMLFormElement>,create:boolean){event.preventDefault();setBusy(true);setMessage('');try{const form=Object.fromEntries(new FormData(event.currentTarget));const result=await api('privacy/source-'+(create?'create':'preview'),{...form,...(create&&preview?{manifestHash:preview.manifestHash,manifestTime:preview.manifestTime}:{})});if(create){setPreview(null);refresh();setMessage(result.message);}else setPreview(result);}catch(e){setMessage(e instanceof Error?e.message:'Unable to process disposal.');}finally{setBusy(false);}}
 return <Panel title="Original-record disposal" note="Preview an exact manifest, obtain independent approval, then explicitly authorize destruction. Current legal holds, mandatory financial retention and retained payroll dependencies are checked again at execution.">
 <form onSubmit={event=>submit(event,!!preview)} onChange={()=>setPreview(null)} className="action-form">
 <label>Employee<select name="employee" required>{staff.map(s=><option key={s.id} value={String(s.id)}>{s.name}</option>)}</select></label>
 <label>Source category<select name="category">{['All',...categories].map(c=><option key={c}>{c}</option>)}</select></label>
 <label>From<input name="from" type="date" required/></label><label>Through<input name="through" type="date" required/></label>
 <label>Destruction authority and purpose<textarea name="reason" required maxLength={2000}/></label>
 {preview&&<><p>{preview.manifestHash}</p><pre className="pay-help">{preview.message}</pre><p>This manifest contains {JSON.parse(preview.message).records} source records. Creating the request does not delete them.</p></>}
 <button disabled={busy} className="btn btn-primary" type="submit">{busy?'Processing…':preview?'Submit frozen manifest for approval':'Preview eligible source records'}</button>
 {message&&<p role="status">{message}</p>}
 </form>
 <p>Personnel disposal requires an ended, suspended account. Direct identity and authentication are removed while an pseudonymous reference preserves required audit links. Authored message content is erased while minimal shared-thread references remain. Private storage deletion uses a retry queue; completion is reported only after queued objects are deleted.</p>
 {(data.sourceDisposals??[]).map(row=><Disclosure key={row.id} title={`${row.name} · ${row.category} · ${row.state}`}>
 <p>{row.reason}</p><p>Manifest {row.manifest_hash} · {row.manifest_count} records · Requested by {row.requested_by}</p>
 <Table rows={(data.sourceItems??[]).filter(i=>i.request_id===row.id)} columns={[{key:'table_name',title:'Source'},{key:'operation',title:'Operation'},{key:'summary',title:'Record'},{key:'eligible_after',title:'Retention satisfied'}]}/>
 {row.state==='Pending'&&row.created_by!==actorId&&row.employee_id!==actorId&&<ActionForm path="privacy/source-review" extra={{id:row.id,revision:row.revision}} fields={[{name:'decision',label:'Decision',options:['Approved','Rejected'],required:true},{name:'reason',label:'Independent authority and evidence',type:'textarea',required:true}]} submit="Record independent decision" refresh={refresh}/>}
 {row.state==='Approved'&&<ActionForm path="privacy/source-execute" extra={{id:row.id,revision:row.revision}} fields={[{name:'confirmation',label:'Type DISPOSE ORIGINALS to irreversibly remove the approved live source records',required:true}]} submit="Dispose approved original records" refresh={refresh}/>}
 {row.state==='Cleanup pending'&&<ActionForm path="privacy/source-cleanup" extra={{id:row.id}} fields={[]} submit="Retry private object destruction" refresh={refresh}/>}
 {['Pending','Approved'].includes(String(row.state))&&<ActionForm path="privacy/source-cancel" extra={{id:row.id,revision:row.revision}} fields={[{name:'reason',label:'Cancellation reason',required:true}]} submit="Cancel unexecuted request" refresh={refresh}/>}
 <Table rows={(data.sourceEvents??[]).filter(e=>e.request_id===row.id)} columns={[{key:'action',title:'Action'},{key:'name',title:'Administrator'},{key:'created_at',title:'When'},{key:'detail',title:'Destruction receipt'}]}/>
 </Disclosure>)}
 </Panel>;
}
