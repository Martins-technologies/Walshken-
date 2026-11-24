import {createHash} from "node:crypto";
import {all,fail,one,type Actor,type Db} from "./server";
import {employmentEngineEnabled,type EmploymentCategory} from "./employment-catalog";
import {validateEmploymentSettings,type HolidaySettings,type PolicySettings} from "./employment-settings";

export const policyHash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type EmploymentTerms = {
 id:string;employee_id:string;effective_on:string;country:string;region_code:string;jurisdiction:string;
 classification:string;city:string;office_id:string|null;time_zone:string;employment_type:string;
 category:string;compensation_type:string;currency:string;frequency:string;expected_hours:number;schedule:string;
};
export type EmploymentPolicy = {
 id:string;org_id:string;country:string;jurisdiction:string;classification:string;category:EmploymentCategory;
 effective_from:string;effective_through:string;version:string;settings:string;settings_hash:string;
 mandatory:boolean;source_url:string;evidence:string;predecessor_id:string|null;created_at:string;created_by:string;
};
export async function employmentTermsOn(db:Db,employee:Pick<Actor,"id"|"org_id">,day:string) {
 if(!employmentEngineEnabled())return null;
 return one<EmploymentTerms>(db,`SELECT * FROM staff_employment_terms WHERE employee_id=? AND org_id=?
  AND effective_on<=? ORDER BY effective_on DESC LIMIT 1`,employee.id,employee.org_id,day);
}
export async function employmentPersonOn<T extends Pick<Actor,"id"|"org_id">>(db:Db,employee:T,day:string) {
 const terms=await employmentTermsOn(db,employee,day);
 return terms?{...employee,...terms,id:employee.id,employmentTermsId:terms.id}:employee;
}

export async function applicablePolicy(db:Db,employee:Pick<Actor,"id"|"org_id">,day:string,category:EmploymentCategory,required=true) {
 const terms=await employmentTermsOn(db,employee,day);
 if(!terms){if(required)return fail(409,"Record effective employment circumstances before applying this policy.");return null;}
 const rows=await all<EmploymentPolicy>(db,`SELECT v.* FROM staff_jurisdiction_versions v
  WHERE v.org_id=? AND v.country=? AND v.jurisdiction=? AND v.classification=? AND v.category=?
  AND v.effective_from<=? AND v.effective_through>=?
  AND (SELECT decision FROM staff_jurisdiction_decisions WHERE version_id=v.id ORDER BY created_at DESC,id DESC LIMIT 1)='Verified'
  ORDER BY v.effective_from DESC,v.created_at DESC,v.id DESC`,employee.org_id,terms.country,terms.jurisdiction,terms.classification,category,day,day);
 if(!rows.length){if(required)return fail(409,`${category} policy for ${terms.jurisdiction} / ${terms.classification} on ${day} is PENDING LEGAL VERIFICATION.`);return null;}
 const row=rows[0];
 if(rows.some(previous=>previous.id!==row.id&&!isPredecessor(previous.id,row,rows)))return fail(409,"Overlapping policy coverage needs a verified supersession chain.");
 let raw:unknown;
 try {raw=JSON.parse(row.settings);}catch{return fail(409,"Policy configuration failed integrity verification.");}
 const settings=validateEmploymentSettings(category,raw);
 if(policyHash(settings)!==row.settings_hash)return fail(409,"Policy configuration failed integrity verification.");
 return {row,settings:settings as PolicySettings,terms};
}
function isPredecessor(target:string,current:EmploymentPolicy,rows:EmploymentPolicy[]) {
 const seen=new Set<string>();let pointer=current.predecessor_id;
 while(pointer&&!seen.has(pointer)){
  if(pointer===target)return true;
  seen.add(pointer);pointer=rows.find(row=>row.id===pointer)?.predecessor_id??null;
 }
 return false;
}

export async function policyDates(db:Db,employee:Pick<Actor,"id"|"org_id">,from:string,to:string) {
 const dates=new Map<string,{day:string;name:string;required:boolean;policyId:string}>();
 if(!employmentEngineEnabled())return {dates:[],configured:false};
 const terms=await employmentTermsOn(db,employee,to);
 if(!terms)return {dates:[],configured:false};
 const changes=await all<{day:string}>(db,`SELECT effective_on AS day FROM staff_employment_terms
  WHERE employee_id=? AND effective_on>? AND effective_on<=?
  UNION SELECT effective_from AS day FROM staff_jurisdiction_versions WHERE org_id=? AND category='Holiday calendar'
  AND effective_from>? AND effective_from<=?`,employee.id,from,to,employee.org_id,from,to);
 let pending=false;
 const boundaries=[...new Set([from,...changes.map(row=>row.day)])].sort();
 for(const boundary of boundaries){
  const rule=await applicablePolicy(db,employee,boundary,"Holiday calendar",false);
  if(!rule){if(await employmentTermsOn(db,employee,boundary))pending=true;continue;}
  for(const holiday of (rule.settings as HolidaySettings).dates){
   if(holiday.date<from||holiday.date>to)continue;
   const actual=await applicablePolicy(db,employee,holiday.date,"Holiday calendar",false);
   if(actual?.row.id!==rule.row.id)continue;
   dates.set(holiday.date,{day:holiday.date,name:holiday.name,required:holiday.required,policyId:rule.row.id});
  }
 }
 return {dates:[...dates.values()].sort((a,b)=>a.day.localeCompare(b.day)),configured:true,pending};
}

export async function assertEmploymentPeriod(db:Db,employee:Pick<Actor,"id"|"org_id">,from:string,to:string) {
 const first=await employmentTermsOn(db,employee,from),last=await employmentTermsOn(db,employee,to);
 if(!first&&!last)return null;
 if(!first||first.id!==last?.id)return fail(409,"An employment assignment changes inside this period. Use boundary-aligned pay periods.");
 const categories:EmploymentCategory[]=["Work","Overtime","Holiday calendar","Leave"];
 const changes=await all<{effective_from:string;effective_through:string}>(db,`SELECT effective_from,effective_through FROM staff_jurisdiction_versions
  WHERE org_id=? AND jurisdiction=? AND classification=? AND effective_from<=? AND effective_through>=?`,employee.org_id,first.jurisdiction,first.classification,to,from);
 const after=(day:string)=>new Date(Date.parse(day+'T12:00Z')+86400000).toISOString().slice(0,10);
 const boundaries=[...new Set([from,to,...changes.flatMap(row=>[row.effective_from,after(row.effective_through)])])].filter(day=>day>=from&&day<=to);
 const applied=[];
 for(const category of categories){
  const policy=await applicablePolicy(db,employee,from,category);
  for(const day of boundaries){
   const current=await applicablePolicy(db,employee,day,category);
   if(policy!.row.id!==current!.row.id)return fail(409,`${category} changes inside the pay period. Split the period at the rule boundary.`);
  }
  applied.push(policy!);
 }
 return {assignment:first,policies:applied};
}
