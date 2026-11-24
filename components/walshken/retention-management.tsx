'use client';
import {ActionForm,Disclosure,Panel,Table,type RecordRow} from './ui';
const categories=['Employee records','Attendance','Timesheets','Payroll','Payslips','Documents','Audit history','Messages','Meeting metadata','Leave records'];
export type RetentionData={versions:RecordRow[];holds:RecordRow[]};
export function RetentionManagement({data,refresh}:{data:RetentionData;refresh:()=>void}){
 return <>
  <Panel title="Retention policies" note="Proposals record legal minimums and company retention periods. Independent review is required. Records with legal obligations require a separately authorized disposal process.">
   <Disclosure title="Propose a retention version"><ActionForm path="governance/retention-save" fields={[
    {name:'country',label:'Employment country',options:[['CA','Canada'],['IN','India'],['PK','Pakistan']],required:true},
    {name:'category',label:'Record category',options:categories,required:true},{name:'classification',label:'Data classification',required:true},
    {name:'minimumDays',label:'Verified legal minimum in days',type:'number',required:true},{name:'retainDays',label:'Company retention in days',type:'number',required:true},
    {name:'effectiveOn',label:'Effective date',type:'date',required:true},{name:'source',label:'Legal or contractual source',type:'url',required:true},
    {name:'reason',label:'Applicability and change reason',type:'textarea',required:true},
   ]} submit="Save retention proposal" refresh={refresh}/></Disclosure>
   <Table rows={data.versions} columns={[{key:'country',title:'Country'},{key:'category',title:'Records'},{key:'retain_days',title:'Days'},{key:'minimum_days',title:'Legal minimum'},{key:'effective_on',title:'Effective'},{key:'status',title:'Review'}]}/>
   {data.versions.filter(row=>row.status==='Pending').map(row=><Disclosure key={row.id} title={`Review ${row.country} · ${row.category}`}><p>{row.reason}</p><ActionForm path="governance/retention-review" extra={{id:row.id}} fields={[{name:'decision',label:'Decision',options:['Approved','Rejected'],required:true},{name:'reason',label:'Independent legal review evidence',type:'textarea',required:true}]} submit="Record decision" refresh={refresh}/></Disclosure>)}
  </Panel>
  <Panel title="Legal holds" note="Active holds prevent document deletion and the message-retention purge. Payroll and audit history retain their existing immutable protections.">
   <Disclosure title="Place a legal hold"><ActionForm path="governance/hold-create" fields={[
    {name:'scope',label:'Hold scope',options:['organization','employee','document','conversation','payroll period'],required:true},
    {name:'target',label:'Record ID, leave blank for organization'}, {name:'reason',label:'Authority and case reference',type:'textarea',required:true},
   ]} submit="Place hold" refresh={refresh}/></Disclosure>
   <Table rows={data.holds} columns={[{key:'scope_type',title:'Scope'},{key:'target_id',title:'Record'},{key:'reason',title:'Authority'},{key:'created_at',title:'Placed'},{key:'released_at',title:'Released'}]}/>
   {data.holds.filter(row=>!row.released_at).map(row=><Disclosure key={row.id} title={`Review release · ${row.scope_type} · ${row.target_id}`}><ActionForm path="governance/hold-release" extra={{id:row.id}} fields={[{name:'reason',label:'Release authority and evidence',type:'textarea',required:true}]} submit="Release hold" refresh={refresh}/></Disclosure>)}
  </Panel>
 </>;
}
