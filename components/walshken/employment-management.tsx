"use client";
import {useState} from "react";
import {employmentCategoryNames} from "@/lib/walshken/employment-catalog";
import {ActionForm,Disclosure,Panel,Table,options,type Field,type RecordRow} from "./ui";

export type EmploymentManagementData={countries:RecordRow[];regions:RecordRow[];terms:RecordRow[];policies:RecordRow[];people:RecordRow[];offices:RecordRow[];leaveAdjustments:RecordRow[]};
const field=(name:string,label:string,type="text",value?:string|number|null):Field=>({name,label,type,value,required:true});
const workFields=[
 ["maxShiftMinutes","Maximum shift length in minutes"],["minRestMinutes","Minimum minutes between shifts"],
 ["changeNoticeMinutes","Shift change notice in minutes"],["restHoursPerWeek","Weekly rest in hours"],
 ["firstBreakAfterMinutes","Work minutes before first break"],["secondBreakFromMinutes","Second break required from minute"],
 ["minimumBreakMinutes","Minimum break duration in minutes"],["minimumSplitMinutes","Minimum split break duration in minutes"],
];
export function EmploymentManagement({data,refresh}:{data:EmploymentManagementData;refresh:()=>void}) {
 const [tab,setTab]=useState("Policies"),[country,setCountry]=useState("CA"),[category,setCategory]=useState("Work"),[copyId,setCopyId]=useState("");
 const regionRows=data.regions.filter(row=>row.country===country);
 const policyRows=data.policies.filter(row=>row.country===country);
 const copy=data.policies.find(row=>row.id===copyId);
 let settings:Record<string,unknown>={};
 if(copy?.settings){try{settings=JSON.parse(String(copy.settings));}catch{/* The server reports any corrupt configuration when applied. */}}
 const jurisdictionOptions=regionRows.map(row=>[String(row.code),String(row.name)] as const);
 return <Panel title="Employment policies" note="Policies follow the employee’s workplace, assessed legal jurisdiction, classification and effective date. Each statutory version requires legal evidence and independent review.">
  <div className="table-filter"><label>Country<select value={country} onChange={event=>setCountry(event.target.value)}>{data.countries.map(row=><option value={String(row.code)} key={row.code}>{row.name}</option>)}</select></label>
   <label>Manage<select value={tab} onChange={event=>setTab(event.target.value)}>{["Policies","Countries","Subdivisions","Employee assignments","Leave adjustments","Coverage"].map(name=><option key={name}>{name}</option>)}</select></label></div>
  {tab==="Countries"&&data.countries.filter(row=>row.code===country).map(row=><ActionForm key={String(row.code)+row.revision} path="governance/employment-country-save" extra={{country:row.code,revision:row.revision}}
   fields={[field("name","Country name","text",row.name),field("currency","Default payroll currency","text",row.currency),{name:"enabled",label:"Available for new employment assignments",type:"checkbox",value:row.enabled?"1":"0"}]} submit="Save employment country" refresh={refresh}/>)}
  {tab==="Subdivisions"&&<>
   <Table rows={regionRows.map(row=>({...row,id:row.code}))} columns={[{key:"code",title:"Code"},{key:"name",title:"Subdivision / jurisdiction"},{key:"kind",title:"Type"},{key:"enabled",title:"New assignments",render:row=>row.enabled?"Available":"Disabled"}]}/>
   <Disclosure title="Add a subdivision or jurisdiction"><ActionForm path="governance/employment-region-save" extra={{country}} fields={[field("code","Unique country-prefixed code"),field("name","Name"),{name:"kind",label:"Type",options:["Province","State","Territory","Union territory","Capital territory","Federal","Other"],required:true},{name:"enabled",label:"Available for new assignments",type:"checkbox",value:"1"}]} submit="Add jurisdiction" refresh={refresh}/></Disclosure>
   {regionRows.map(row=><Disclosure title={`Edit ${row.name}`} key={row.code}><ActionForm path="governance/employment-region-save" extra={{code:row.code,country:row.country,revision:row.revision}} fields={[field("name","Name","text",row.name),{name:"kind",label:"Type",options:["Province","State","Territory","Union territory","Capital territory","Federal","Other"],value:row.kind,required:true},{name:"enabled",label:"Available for new assignments",type:"checkbox",value:row.enabled?"1":"0"}]} submit="Save subdivision" refresh={refresh}/></Disclosure>)}
  </>}
  {tab==="Employee assignments"&&<>
   <Disclosure title="Schedule an employment assignment"><ActionForm key={country} path="governance/employment-terms-save" extra={{country}} fields={[
    {name:"employee",label:"Employee",options:options(data.people),required:true},field("effectiveOn","Effective date","date"),
    {name:"region",label:"Actual workplace province, state or territory",options:jurisdictionOptions,required:true},
    {name:"jurisdiction",label:"Assessed employment jurisdiction",options:jurisdictionOptions,required:true},
    field("classification","Covered employment classification"),field("city","City"),{name:"office",label:"Office",options:options(data.offices)},
    field("timeZone","Workplace IANA time zone"),{name:"employmentType",label:"Employment type",options:["Full-time","Part-time","Fixed-term","Contractor"],required:true},
    field("employeeCategory","Employee category"),{name:"compensationType",label:"Compensation type",options:["Hourly","Salaried","Contract fee"],required:true},
    field("currency","Payroll currency","text",data.countries.find(row=>row.code===country)?.currency),
    {name:"frequency",label:"Pay frequency",options:["Weekly","Biweekly","Semimonthly","Monthly"],required:true},
    field("expectedHours","Expected weekly hours","number"),field("schedule","Work schedule"),field("reference","Employment classification and applicability evidence","textarea"),
   ]} submit="Record effective assignment" refresh={refresh}/></Disclosure>
   <Table rows={data.terms.filter(row=>row.country===country)} columns={[{key:"name",title:"Employee"},{key:"effective_on",title:"Effective date"},{key:"region_code",title:"Workplace"},{key:"jurisdiction",title:"Employment jurisdiction"},{key:"classification",title:"Classification"},{key:"currency",title:"Currency"},{key:"frequency",title:"Pay frequency"}]}/>
  </>}
  {tab==='Leave adjustments'&&<>
    <ActionForm path="governance/employment-leave-adjust" fields={[
     {name:'employee',label:'Employee',options:options(data.people),required:true},field('code','Verified leave category code'),
     field('effectiveOn','Effective date','date'),{name:'kind',label:'Adjustment type',options:['Opening balance','Correction','Carry forward'],required:true},
     field('minutes','Adjustment in minutes, signed for a correction','number'),field('reason','Source and reason','textarea'),
    ]} submit="Submit leave adjustment" refresh={refresh}/>
    <Table rows={data.leaveAdjustments} columns={[{key:'name',title:'Employee'},{key:'code',title:'Leave category'},{key:'kind',title:'Adjustment'},{key:'minutes',title:'Minutes'},{key:'effective_on',title:'Effective'},{key:'status',title:'Review'}]}/>
    {data.leaveAdjustments.filter(row=>row.status==='Pending').map(row=><Disclosure key={row.id} title={`Review ${row.name} · ${row.code} · ${row.minutes} minutes`}>
     <p>{row.reason}</p><ActionForm path="governance/employment-leave-adjust-review" extra={{id:row.id}} fields={[{name:'decision',label:'Decision',options:['Approved','Rejected'],required:true},field('reason','Independent review evidence','textarea')]} submit="Record decision" refresh={refresh}/>
    </Disclosure>)}
   </>}
  {tab==="Coverage"&&<ActionForm path="governance/employment-coverage" fields={[{name:"employee",label:"Employee",options:options(data.people),required:true},field("day","Policy application date","date")]} submit="Check verified coverage" refresh={()=>{}}/>}
  {tab==="Policies"&&<>
   <Table rows={policyRows} columns={[{key:"jurisdiction",title:"Jurisdiction"},{key:"classification",title:"Covered classification"},{key:"category",title:"Policy"},{key:"version",title:"Version"},{key:"effective_from",title:"Starts"},{key:"effective_through",title:"Ends"},{key:"status",title:"Review status",render:row=>row.status==="Draft"?"PENDING LEGAL VERIFICATION":String(row.status)}]}/>
   <div className="table-filter"><label>Policy category<select value={category} onChange={event=>{setCategory(event.target.value);setCopyId("");}}>{employmentCategoryNames.filter(name=>name!=="Evidence").map(name=><option key={name}>{name}</option>)}</select></label>
    <label>Copy or replace a previous version<select value={copyId} onChange={event=>{setCopyId(event.target.value);const previous=data.policies.find(row=>row.id===event.target.value);if(previous)setCategory(String(previous.category));}}><option value="">Create new coverage</option>{policyRows.filter(row=>row.category===category).map(row=><option value={String(row.id)} key={row.id}>{row.jurisdiction} · {row.classification} · {row.version}</option>)}</select></label></div>
   <Disclosure title={copy?`Create a new version from ${copy.version}`:"Create a policy version"}>
    <ActionForm key={country+category+copyId} path="governance/employment-policy-save" extra={{category,predecessor:copy?.id??""}} fields={[
     {name:"jurisdiction",label:"Employment jurisdiction",options:jurisdictionOptions,value:copy?.jurisdiction,required:true},
     field("classification","Exact covered classification","text",copy?.classification),field("version","Unique version name"),
     field("effectiveFrom","Effective from","date"),field("effectiveThrough","Effective through","date"),
     {name:"mandatory",label:"Statutory requirement",type:"checkbox",value:copy?.mandatory?"1":"0"},
     ...policyFields(category,settings),field("source","Official legal source","url",copy?.source_url),field("evidence","Legal applicability and reason for this change","textarea"),
    ]} submit="Save for independent legal review" refresh={refresh}/>
   </Disclosure>
   {policyRows.map(row=><Disclosure key={row.id} title={`${row.jurisdiction} · ${row.category} · ${row.version}`}>
    <p>{row.evidence}</p><p><a href={String(row.source_url)} rel="noreferrer" target="_blank">Official source</a></p>
    <PolicyComparison previous={data.policies.find(previous=>previous.id===row.predecessor_id)} current={row}/>
    {row.status==="Draft"&&<ActionForm path="governance/jurisdiction-verify" extra={{id:row.id}} fields={[field("reason","Independent legal review evidence","textarea")]} submit="Verify and activate dated version" refresh={refresh}/>}
    {row.status!=="Withdrawn"&&!(row.mandatory&&row.status==="Verified")&&<ActionForm path="governance/jurisdiction-withdraw" extra={{id:row.id}} fields={[field("reason","Withdrawal reason","textarea")]} submit="Withdraw version" refresh={refresh}/>}
   </Disclosure>)}
  </>}
 </Panel>;
}
function policyFields(category:string,settings:Record<string,unknown>):Field[] {
 if(category==="Work")return workFields.map(([name,label])=>field(name,label,"number",settings[name] as number|undefined));
 if(category==="Overtime")return [["dailyHours","Daily threshold in hours"],["weeklyHours","Weekly threshold in hours"],["multiplier","Overtime multiplier"],["weekStart","Workweek first day (Sunday 0 to Saturday 6)"]].map(([name,label])=>field(name,label,"number",settings[name] as number|undefined));
 return [field("settings",category==="Canada Alberta payroll"?'Annual Canadian Alberta payroll parameters JSON':category==="Holiday calendar"?'Dated holidays JSON, with dates containing date, name and required':'Leave policy JSON, with workdays, dayMinutes, yearStartMonth, proration and categories. Each category has code, name, paid, annualMinutes, carryMinutes, accrual and minimumServiceDays',"textarea",Object.keys(settings).length?JSON.stringify(settings,null,2):"")];
}
function PolicyComparison({previous,current}:{previous?:RecordRow;current:RecordRow}) {
 const parse=(row?:RecordRow):Record<string,unknown>=>{try{return JSON.parse(String(row?.settings??"{}"));}catch{return {};}};
 const old=parse(previous),next=parse(current),keys=[...new Set([...Object.keys(old),...Object.keys(next)])];
 return <Table rows={keys.map(key=>({id:key,setting:key,previous:JSON.stringify(old[key])??"",current:JSON.stringify(next[key])??""}))} columns={[{key:"setting",title:"Setting"},{key:"previous",title:previous?`Previous · ${previous.version}`:"Previous"},{key:"current",title:`Current · ${current.version}`}]}/>;
}
