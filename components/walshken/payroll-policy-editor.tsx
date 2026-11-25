"use client";

import {useState, type FormEvent} from "react";
import {api, FieldInput, type Field, type RecordRow} from "./ui";
import "./payroll-policy-editor.css";

export type PolicySuggestion = {
 id:string; country:string; jurisdiction:string; category:string; classification?:string;
 version:string; source:string; effectiveFrom:string; effectiveThrough:string;
 settings:Record<string,unknown>;
};
type Settings=Record<string,unknown>;
type Scalar=string|number|boolean|null;
const payStandardFields:Field[]=[
 {name:"currency",label:"Payroll currency",options:["CAD","INR","PKR"],required:true},
 {name:"minimumHourly",label:"Company minimum hourly pay",type:"number",min:0,required:true},
 {name:"minimumMonthly",label:"Company minimum monthly pay",type:"number",min:0,required:true},
 {name:"vacationPercent",label:"Vacation pay (%)",type:"number",min:0,required:true},
 {name:"longServiceYears",label:"Years before the long-service vacation rate",type:"number",min:0,required:true},
 {name:"longServiceVacationPercent",label:"Long-service vacation pay (%)",type:"number",min:0,required:true},
 {name:"paymentDeadlineDays",label:"Payment deadline after period end (days)",type:"number",min:0,required:true},
 {name:"holidayPremiumMultiplier",label:"Holiday work pay multiplier",type:"number",min:0,required:true},
 {name:"holidayMethod",label:"Holiday base-pay calculation",options:["Normal day","Average worked day","Percent of earnings"],required:true},
 {name:"holidayWindowDays",label:"Holiday wage-averaging window (days)",type:"number",min:1,required:true},
 {name:"holidayWindowBasis",label:"Holiday reference-window basis",options:["Before holiday","Complete workweeks"],required:true},
 {name:"holidayDivisor",label:"Holiday divisor (0 = actual worked days)",type:"number",min:0,required:true},
 {name:"holidayPayOnNonWorkday",label:"Pay the holiday on a non-working day",type:"checkbox"},
 {name:"holidayPercent",label:"Holiday pay as a percentage of earnings (%)",type:"number",min:0,required:true},
 {name:"minimumServiceDays",label:"Service days before holiday entitlement",type:"number",min:0,required:true},
 {name:"minimumWorkedDays",label:"Worked days before holiday entitlement",type:"number",min:0,required:true},
 {name:"eligibilityLookbackMonths",label:"Eligibility lookback (months; optional; 0 = no previous months)",type:"number",min:0,max:12},
 {name:"regularDayLookbackWeeks",label:"Regular-day lookback (weeks; optional; 0 = no past weeks)",type:"number",min:0,max:52},
 {name:"regularDayMinimumOccurrences",label:"Regular-day occurrences (optional; 0 = every weekday)",type:"number",min:0,max:52},
 {name:"reportingHours",label:"Minimum reporting-pay hours",type:"number",min:0,required:true},
 {name:"reportingRate",label:"Reporting-pay rate basis",options:["Minimum wage","Ordinary wage"],required:true},
];
const overtimeFields:Field[]=[
 {name:"dailyHours",label:"Daily overtime threshold (hours; 0 = disabled)",type:"number",min:0,required:true},
 {name:"weeklyHours",label:"Weekly overtime threshold (hours; 0 = disabled)",type:"number",min:0,required:true},
 {name:"multiplier",label:"Overtime pay multiplier (0 = no overtime pay)",type:"number",min:0,required:true},
 {name:"weekStart",label:"Workweek first day",options:[["0","Sunday"],["1","Monday"],["2","Tuesday"],["3","Wednesday"],["4","Thursday"],["5","Friday"],["6","Saturday"]],required:true},
];
const optionalPayStandardKeys=["eligibilityLookbackMonths","regularDayLookbackWeeks","regularDayMinimumOccurrences"];
const numberKeys=new Set(["longServiceYears","paymentDeadlineDays","holidayWindowDays","holidayDivisor","minimumServiceDays","minimumWorkedDays","reportingHours","dailyHours","weeklyHours","weekStart",...optionalPayStandardKeys]);
const labelNames:Record<string,string>={
 ympe:"First pension earnings ceiling",yampe:"Second pension earnings ceiling",cppRate:"CPP / QPP employee rate",cppBaseRate:"CPP / QPP base rate",cppMax:"Annual pension maximum",cpp2Rate:"Second additional pension rate",cpp2Max:"Second additional pension annual maximum",cppExemption:"Annual pension exemption",eiRate:"Employee employment-insurance rate",eiMax:"Annual employment-insurance maximum",eiEmployerMultiplier:"Employer employment-insurance multiplier",bpaMax:"Federal basic personal amount",bpaMin:"Federal minimum personal amount",bpaPhaseStart:"Basic-amount phase-out starts",bpaPhaseEnd:"Basic-amount phase-out ends",abClaim:"Provincial basic personal amount",cea:"Employment credit amount",abSupplementThreshold:"Supplement threshold",abSupplementRate:"Supplement rate",bonusFlatThreshold:"Bonus flat-rate threshold",bonusFlatRate:"Bonus flat rate",federalBrackets:"Federal income-tax brackets",provincialBrackets:"Provincial income-tax brackets",employeeRate:"Employee contribution rate",employerRate:"Employer contribution rate",employerTotalRate:"Total employer contribution rate (includes the pension split)",eligibilityKey:"Recorded applicability key (metadata; scheme code controls applicability)",monthlyCeiling:"Monthly contribution wage ceiling (0 = uncapped)",annualCeiling:"Annual contribution wage ceiling (0 = uncapped)",employeeExemptDailyBelow:"Employee daily-wage exemption threshold",standardDeduction:"Standard annual deduction",cess:"Cess rate",slabs:"Income-tax bands",surcharge:"Surcharge bands",contributions:"Contribution schemes",qpRate:"Employee QPIP rate",qpEmployerRate:"Employer QPIP rate",qpMax:"Annual employee QPIP maximum",qpInsurableMax:"Annual QPIP insurable-earnings ceiling",federalTaxMultiplier:"Federal tax multiplier (1 = full tax; 0 = zero)",bonusLowRate:"Lower lump-sum tax rate",workersRate:"Worker deduction rate",workersMaximum:"Worker deduction maximum",from:"Threshold starts",fixed:"Fixed tax amount",rate:"Rate",maximum:"Maximum amount",threshold:"Threshold",marginalRelief:"Apply marginal relief",annualMinutes:"Annual leave allowance (minutes)",carryMinutes:"Carry-forward allowance (minutes)",minimumServiceDays:"Service days before eligibility",dayMinutes:"Normal working day (minutes)",yearStartMonth:"Leave-year start month",workdays:"Working weekdays (0 = Sunday)",categories:"Leave categories",
};
function labelFor(key:string){return labelNames[key]??key.replace(/([a-z])([A-Z])/g,"$1 $2").replace(/^./,value=>value.toUpperCase());}
function cleanSettings(value:Settings):Settings {const copy=structuredClone(value);delete copy.companyConfigured;for(const key of optionalPayStandardKeys)if(copy[key]===""||copy[key]===undefined)delete copy[key];return copy;}
function parseSettings(row?:RecordRow):Settings {try{const parsed=JSON.parse(String(row?.settings??"{}"));return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?cleanSettings(parsed):{};}catch{return {};}}
function showValue(value:unknown){return value===undefined?"No maintained reference":typeof value==="boolean"?value?"Yes":"No":value===null?"None":String(value);}
function atPath(value:unknown,path:(string|number)[]):unknown {let result=value;for(const key of path){if(result===null||typeof result!=="object")return undefined;result=(result as Record<string|number,unknown>)[key];}return result;}
function updatePath(value:Settings,path:(string|number)[],replacement:unknown):Settings {const result=structuredClone(value);let cursor:Record<string|number,unknown>=result;for(const key of path.slice(0,-1))cursor=cursor[key] as Record<string|number,unknown>;cursor[path[path.length-1]]=replacement;return result;}
function isRecord(value:unknown):value is Settings{return value!==null&&typeof value==="object"&&!Array.isArray(value);}

export function PayrollPolicyEditor({category,country,copy,suggestions,jurisdictions,refresh}:{category:string;country:string;copy?:RecordRow;suggestions:PolicySuggestion[];jurisdictions:readonly (readonly [string,string])[];refresh:()=>void}){
 const possible=suggestions.filter(item=>item.category===category&&item.country===country);
 const initialReference=copy?(possible.find(item=>(!item.jurisdiction||item.jurisdiction===copy.jurisdiction)&&item.version===parseSettings(copy).version)??possible.find(item=>!item.jurisdiction||item.jurisdiction===copy.jurisdiction)):undefined;
 const [referenceId,setReferenceId]=useState(initialReference?.id??"");
 const [settings,setSettings]=useState<Settings>(()=>copy?parseSettings(copy):category==="Pay standards"?{currency:({CA:"CAD",IN:"INR",PK:"PKR"} as Record<string,string>)[country],holidayPayOnNonWorkday:false}:{});
 const [jurisdiction,setJurisdiction]=useState(String(copy?.jurisdiction??""));
 const [classification,setClassification]=useState(String(copy?.classification??""));
 const [mode,setMode]=useState<"fields"|"json">("fields"),[jsonText,setJsonText]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const reference=possible.find(item=>item.id===referenceId);
 const fields=category==="Pay standards"?payStandardFields:category==="Overtime"?overtimeFields:null;
 function changeMode(next:"fields"|"json"){
  setError("");
  if(next==="json")setJsonText(JSON.stringify(settings,null,2));
  else{try{const parsed=JSON.parse(jsonText);if(!isRecord(parsed))throw new Error("Enter a settings object.");setSettings(cleanSettings(parsed));}catch{setError("Enter valid policy JSON before returning to the fields.");return;}}
  setMode(next);
 }
 async function save(event:FormEvent<HTMLFormElement>){
  event.preventDefault();setError("");setNotice("");
  const formData=new FormData(event.currentTarget),body=Object.fromEntries(formData);
  let values=cleanSettings(settings);
  if(mode==="json"){try{const parsed=JSON.parse(jsonText);if(!isRecord(parsed))throw new Error();values=cleanSettings(parsed);}catch{setError("Enter a valid settings object.");return;}}
  setBusy(true);
  try{
   const result=await api("governance/employment-policy-save",{...body,category,jurisdiction,predecessor:copy?.id??"",mandatory:Boolean(copy?.mandatory),settings:JSON.stringify({...values,companyConfigured:true})});
   setNotice(result.message??"Company policy version saved for review.");refresh();
  }catch(cause){setError(cause instanceof Error?cause.message:"The policy could not be saved.");}finally{setBusy(false);}
 }
 return <form className="staff-form company-policy-form" onSubmit={save}>
  <div className="company-policy-intro"><strong>Company settings used for calculation</strong><p>Government values are reference suggestions. You can enter your company’s values, including 0. Saving creates a dated version for policy review; it does not rewrite finalized payroll.</p><p>Jurisdiction settings apply to employees who inherit them. An employee-specific payroll override takes precedence.</p></div>
  <div className="staff-fields">
   <label>Employment jurisdiction<select name="jurisdiction" required value={jurisdiction} onChange={event=>{const next=event.target.value;setJurisdiction(next);if(reference?.jurisdiction&&reference.jurisdiction!==next)setReferenceId("");}}><option value="">Choose…</option>{jurisdictions.map(([code,name])=><option key={code} value={code}>{name}</option>)}</select></label>
   <label>Covered employee classification<input name="classification" required value={classification} onChange={event=>setClassification(event.target.value)}/></label>
   <FieldInput field={{name:"version",label:"New company policy version name",required:true}}/>
   <FieldInput field={{name:"effectiveFrom",label:"Effective from",type:"date",required:true}}/>
   <FieldInput field={{name:"effectiveThrough",label:"Effective through",type:"date",required:true}}/>
  </div>
  <div className="company-policy-reference">
   <label>Government reference suggestion<select value={referenceId} onChange={event=>setReferenceId(event.target.value)}><option value="">No reference selected</option>{possible.filter(item=>!jurisdiction||!item.jurisdiction||item.jurisdiction===jurisdiction).map(item=><option key={item.id} value={item.id}>{item.jurisdiction||item.country+" national reference"} · {item.version} · {item.effectiveFrom} to {item.effectiveThrough}</option>)}</select></label>
   {reference?<><p><a href={reference.source} target="_blank" rel="noreferrer">Open government reference</a> · {reference.effectiveFrom} to {reference.effectiveThrough}</p><button type="button" className="btn btn-outline btn-small" onClick={()=>{setSettings(cleanSettings(reference.settings));if(reference.jurisdiction)setJurisdiction(reference.jurisdiction);setClassification(current=>current||reference.classification||"");setMode("fields");setError("");}}>Use reference values as starting values</button><small>Review and edit the company values below before saving. This does not change the published reference.</small></>:<p>No government value has been selected. Start from an existing company version or enter the settings. Blank inputs are not automatically converted to zero.</p>}
  </div>
  {category==="Overtime"&&<p className="company-policy-help">A threshold of 0 disables that daily or weekly threshold. A multiplier of 0 pays zero for overtime; overtime time is still recorded.</p>}
  {category==="Pay standards"&&<p className="company-policy-help">The optional eligibility lookback is separate from the wage-averaging window; leave it blank to use the wage window. Supply both regular-day fields together, or leave both blank to use the employee’s normal working weekdays.</p>}
  <div className="company-policy-mode" role="group" aria-label="Policy editing format"><button type="button" aria-pressed={mode==="fields"} disabled={mode==="fields"} onClick={()=>changeMode("fields")}>Edit fields</button><button type="button" aria-pressed={mode==="json"} disabled={mode==="json"} onClick={()=>changeMode("json")}>Advanced JSON</button></div>
  {mode==="json"?<label>Company policy settings JSON<textarea rows={16} required value={jsonText} maxLength={50000} onChange={event=>setJsonText(event.target.value)}/></label>:fields?<div className="company-policy-grid">{fields.map(field=><PolicyValueInput key={field.name} field={field} value={settings[field.name]} suggested={reference?.settings[field.name]} onChange={value=>setSettings(current=>({...current,[field.name]:numberKeys.has(field.name)&&value!==""?Number(value):value}))}/>)}</div>:Object.keys(settings).length?<><p className="company-policy-help">Tax and contribution rates use decimal fractions: 0.05 means 5%. Amounts use {String(settings.currency??({CA:"CAD",IN:"INR",PK:"PKR"} as Record<string,string>)[country])}; annual and monthly fields keep their stated period. Rate and amount fields accept zero. Dates, methods and ordered bands must still form a valid calculation.</p><PolicyPackageFields value={settings} reference={reference?.settings} path={[]} onChange={(path,value)=>setSettings(current=>updatePath(current,path,value))}/></>:<p className="company-policy-help">Choose a reference package above and use its starting values to edit the rates, thresholds and contribution rules as individual fields. You can also paste a complete company package in Advanced JSON.</p>}
  <div className="staff-fields">
   <FieldInput key={referenceId+":source"} field={{name:"source",label:"Government reference URL",type:"url",required:true,value:reference?.source??copy?.source_url}}/>
   <FieldInput field={{name:"evidence",label:"Reason and approval reference for these company settings",type:"textarea",required:true,max:12000}}/>
  </div>
  <button className="btn btn-blue btn-small" disabled={busy}>{busy?"Saving…":"Save company policy for review"}</button>
  {error&&<p className="form-error" role="alert">{error}</p>}{notice&&<p className="form-success" role="status">{notice}</p>}
 </form>;
}

function PolicyValueInput({field,value,suggested,onChange}:{field:Field;value:unknown;suggested:unknown;onChange:(value:Scalar)=>void}){
 const current=value===undefined||value===null?"":String(value),changed=suggested!==undefined&&String(value)!==String(suggested);
 return <label className="company-policy-value"><span>{field.label}</span>{field.type==="checkbox"?<input type="checkbox" checked={value===true} onChange={event=>onChange(event.target.checked)}/>:field.options?<select required={field.required} value={current} onChange={event=>onChange(event.target.value)}><option value="">Choose…</option>{field.options.map(option=>{const [key,label]=typeof option==="string"?[option,option]:option;return <option key={key} value={key}>{label}</option>;})}</select>:<input type={field.type??"text"} value={current} required={field.required} min={field.min} max={field.max} step={field.type==="number"?"any":undefined} onChange={event=>onChange(event.target.value)}/>}
 <small>Reference: {showValue(suggested)}{changed&&<strong> · Company value</strong>}</small></label>;
}
function emptyArrayEntry(key:string):unknown {
 if(key.endsWith("Brackets"))return [0,"0",0];
 if(key==="slabs")return {from:"0",rate:"0",fixed:"0"};
 if(key==="surcharge")return {from:"0",rate:"0"};
 if(key==="workdays")return 0;
 if(key==="categories")return {code:"",name:"",paid:false,annualMinutes:0,carryMinutes:0,accrual:"Annual",minimumServiceDays:0};
 if(key==="contributions")return {code:"",label:"",basis:"gross",employeeRate:"0",employerRate:"0",monthlyCeiling:"0",annualCeiling:"0",source:"",rounding:"rupee",eligibilityKey:""};
 return undefined;
}
function PolicyPackageFields({value,reference,path,onChange}:{value:unknown;reference:unknown;path:(string|number)[];onChange:(path:(string|number)[],value:unknown)=>void}){
 if(value===null||typeof value!=="object")return null;
 const entries=Array.isArray(value)?value.map((item,index)=>[index,item] as const):Object.entries(value).filter(([key])=>key!=="companyConfigured"&&!(key==="employerRate"&&isRecord(value)&&value.employerTotalRate!==undefined)&&!(path.length===0&&isRecord(value)&&isRecord(value.region)&&key==="abClaim")&&!(path.length===1&&path[0]==="region"&&["pensionRate","pensionBaseRate","pensionMax","eiRate","eiMax"].includes(key)));
 return <div className="company-policy-package">{entries.map(([key,item])=>{
  const childPath=[...path,key],ref=atPath(reference,[key]);
  const rowLabel=typeof key==="number"?Array.isArray(value)&&path[path.length-1]?.toString().endsWith("Brackets")?`Band ${key+1}`:Array.isArray(value)&&typeof path[path.length-1]==="number"&&path[path.length-2]?.toString().endsWith("Brackets")?["Threshold","Rate (decimal)","Offset"][key]??`Value ${key+1}`:`Item ${key+1}`:labelFor(key);
  if(item!==null&&typeof item==="object")return <fieldset key={key} className="company-policy-group"><legend>{rowLabel}{isRecord(item)&&typeof item.label==="string"?` · ${item.label}`:""}</legend><PolicyPackageFields value={item} reference={ref} path={childPath} onChange={onChange}/>{Array.isArray(item)&&<div className="company-policy-array-actions"><button type="button" className="text-link" disabled={!item.length&&emptyArrayEntry(String(key))===undefined} onClick={()=>onChange(childPath,[...item,structuredClone(item.length?item[item.length-1]:emptyArrayEntry(String(key)))])}>Add {item.length?"an entry based on the last row":"an entry"}</button>{item.length>0&&<button type="button" className="text-link" onClick={()=>onChange(childPath,item.slice(0,-1))}>Remove last entry</button>}</div>}</fieldset>;
  const numeric=typeof item==="number"||typeof item==="string"&&/^\d*\.?\d+$/.test(item),type=typeof item==="boolean"?"checkbox":numeric?"number":typeof item==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(item)?"date":"text";
  return <PolicyValueInput key={key} field={{name:childPath.join("."),label:numeric&&typeof key==="string"&&(/rate$/i.test(key)||key==="cess")?rowLabel+" (decimal: 0.05 = 5%)":rowLabel,type,required:type!=="checkbox",...(numeric?{min:0}:{})}} value={item} suggested={ref} onChange={next=>onChange(childPath,typeof item==="number"&&next!==""?Number(next):next)}/>;
 })}</div>;
}
