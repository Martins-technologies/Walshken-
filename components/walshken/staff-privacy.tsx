'use client';
import {SourceDisposals,type SourceDisposalData} from './source-disposal';
import {ActionForm,Disclosure,Panel,Quick,Table,options,type RecordRow} from './ui';
export type PrivacyData=SourceDisposalData&{privacy?:boolean;rows:RecordRow[];staff:RecordRow[];events:RecordRow[];categories:readonly string[];actorId:string;canManage:boolean;canExport:boolean;canDispose:boolean};
export function StaffPrivacy({data,refresh}:{data:PrivacyData;refresh:()=>void}){
 const operations=['Export',...(data.canManage?['Archive','Restore']:[]),...(data.canDispose?['Dispose']:[])];
 return <>{data.sourceDisposals&&<SourceDisposals data={data} staff={data.staff} categories={data.categories} actorId={data.actorId} refresh={refresh}/>}<Panel title="Private records requests" note="Exports contain your own records and authored messages. Finalized earnings are included; original files, passwords, authenticator secrets and other employees’ messages are excluded. Every request requires independent authorization.">
 <ActionForm path="privacy/create" fields={[{name:'employee',label:'Employee',options:options(data.staff),required:true},{name:'kind',label:'Operation',options:operations,required:true},{name:'category',label:'Record category',options:['All',...data.categories],required:true},{name:'from',label:'From',type:'date',required:true},{name:'through',label:'Through',type:'date',required:true},{name:'reason',label:'Purpose and authority',type:'textarea',required:true}]} submit="Submit request" refresh={refresh}/>
 <p>Archive creates an immutable, integrity-checked snapshot in private storage. Restore releases a new authorized copy. Dispose revokes eligible archive copies and queues their physical deletion after retention and legal-hold checks. These operations preserve operational payroll and audit records under their separate retention protections.</p>
 <Table rows={data.rows} columns={[{key:'name',title:'Employee'},{key:'kind',title:'Operation'},{key:'category',title:'Records'},{key:'state',title:'Status'},{key:'created_at',title:'Requested'}]}/>
 </Panel>
 {data.rows.map(row=><Disclosure key={row.id} title={`${row.name} · ${row.kind} · ${row.state}`}>
 <p>{row.reason}</p><p>{row.from_date} to {row.through_date} · Requested by {row.requested_by}</p>
 {row.state==='Pending'&&row.created_by!==data.actorId&&(row.kind==='Export'?data.canExport:row.kind==='Dispose'?data.canDispose:data.canManage)&&<ActionForm path="privacy/review" extra={{id:row.id,revision:row.revision}} fields={[{name:'decision',label:'Decision',options:['Approved','Rejected'],required:true},{name:'reason',label:'Independent authorization evidence',type:'textarea',required:true}]} submit="Record decision" refresh={refresh}/>}
 {row.state==='Approved'&&(row.kind==='Export'?data.canExport:row.kind==='Dispose'?data.canDispose:data.canManage)&&<Quick path="privacy/execute" data={{id:row.id,revision:row.revision}} refresh={refresh}>Execute authorized operation</Quick>}
 {row.state==='Completed'&&row.artifact_key&&(!row.artifact_expires_at||String(row.artifact_expires_at)>new Date().toISOString())&&<a className="btn btn-outline btn-small" href={`/api/workspace/privacy-download/${row.id}`}>Download private copy</a>}
 {row.artifact_hash&&<p className="field-hint">SHA-256: {row.artifact_hash}</p>}
 <Table rows={data.events.filter(v=>v.request_id===row.id)} columns={[{key:'action',title:'Action'},{key:'name',title:'Administrator'},{key:'created_at',title:'Time'},{key:'detail',title:'Evidence'}]}/>
 </Disclosure>)}
 {data.canManage&&<Panel title="Private storage cleanup" note="Revoked or expired copies are deleted through a durable retry queue. Active archives remain protected."><Quick path="privacy/cleanup" data={{}} refresh={refresh}>Process eligible storage cleanup</Quick></Panel>}
 </>;
}
