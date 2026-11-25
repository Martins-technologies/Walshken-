import type {LeaveSettings} from "./employment-settings";
import {all,audit,fail,id,integer,json,now,one,pick,requireSuper,run,str,timeZone,type Actor,type Db} from "./server";
import {employmentCategoryNames,employmentEngineEnabled,employmentRegions,type EmploymentCategory} from "./employment-catalog";
import {employmentCountries} from "./jurisdiction-catalog";
import {applicablePolicy,employmentTermsOn,policyHash,type EmploymentPolicy} from "./employment-engine";
import {validateEmploymentSettings} from "./employment-settings";
import {validDay} from "./holiday-access";
import {maintainedCanadaTaxPackages} from "./payroll-canada-packages";
import {nationalTaxPackages} from "./payroll-national-packages";
import {localDate} from "./work";

async function initializeEmploymentCatalog(db:Db,actor:Actor){
 if(await one(db,'SELECT code FROM employment_countries WHERE org_id=? LIMIT 1',actor.org_id))return;
 await db.transaction(async tx=>{
  await one(tx,'SELECT id FROM organizations WHERE id=? FOR UPDATE',actor.org_id);
  if(await one(tx,'SELECT code FROM employment_countries WHERE org_id=? LIMIT 1',actor.org_id))return;
  for(const [code,entry] of Object.entries(employmentCountries))await run(tx,'INSERT INTO employment_countries(org_id,code,name,currency,updated_by,updated_at) VALUES(?,?,?,?,?,?)',actor.org_id,code,entry.name,entry.currency,actor.id,now());
  for(const region of employmentRegions)await run(tx,'INSERT INTO employment_regions(org_id,code,country,name,kind,updated_by,updated_at) VALUES(?,?,?,?,?,?,?)',actor.org_id,region.code,region.country,region.name,region.kind,actor.id,now());
 });
}
export async function employmentData(db:Db,actor:Actor) {
 requireSuper(actor);
 if(!employmentEngineEnabled())return null;
 await initializeEmploymentCatalog(db,actor);
 const [countries,regions,terms,policies,people,offices,leaveAdjustments]=await Promise.all([
  all(db,"SELECT * FROM employment_countries WHERE org_id=? ORDER BY code",actor.org_id),
  all(db,"SELECT * FROM employment_regions WHERE org_id=? ORDER BY country,name",actor.org_id),
  all(db,`SELECT t.*,e.name FROM staff_employment_terms t JOIN employees e ON e.id=t.employee_id WHERE t.org_id=? ORDER BY t.effective_on DESC,t.created_at DESC LIMIT 500`,actor.org_id),
  all(db,`SELECT v.*,COALESCE(d.decision,'Draft') AS status,d.reason AS review_reason FROM staff_jurisdiction_versions v
   LEFT JOIN LATERAL (SELECT decision,reason FROM staff_jurisdiction_decisions WHERE version_id=v.id ORDER BY created_at DESC,id DESC LIMIT 1) d ON true
   WHERE v.org_id=? AND v.category<>'Evidence' ORDER BY v.created_at DESC,v.id DESC LIMIT 500`,actor.org_id),
  all(db,"SELECT id,name FROM employees WHERE org_id=? AND role<>'guest' ORDER BY name",actor.org_id),
  all(db,"SELECT id,name FROM units WHERE org_id=? AND kind='Office' ORDER BY name",actor.org_id),
  all(db,`SELECT a.*,e.name,COALESCE(r.decision,'Pending') AS status,r.reason AS review_reason FROM staff_leave_adjustments a
   JOIN employees e ON e.id=a.employee_id LEFT JOIN staff_leave_adjustment_reviews r ON r.adjustment_id=a.id
   WHERE a.org_id=? ORDER BY a.created_at DESC LIMIT 300`,actor.org_id),
 ]);
 return {countries,regions,terms,policies,people,offices,leaveAdjustments};
}
export async function employmentAction(db:Db,actor:Actor,action:string,data:Record<string,unknown>) {
 requireSuper(actor);
 if(!employmentEngineEnabled())return fail(404,"Employment policy management is unavailable.");
 await initializeEmploymentCatalog(db,actor);
 return db.transaction(async tx=>{
  await one(tx,"SELECT id FROM organizations WHERE id=? FOR UPDATE",actor.org_id);
  if(action==="employment-country-save"){
   const code=pick(data.country,["CA","IN","PK"] as const,"country"),currency=str(data.currency,"currency",3).toUpperCase();
   if(!/^[A-Z]{3}$/.test(currency))return fail(400,"Enter a valid currency code.");
   try{new Intl.NumberFormat('en',{style:'currency',currency}).format(0);}catch{return fail(400,"Invalid currency.");}
   const old=await one<{revision:number}>(tx,"SELECT revision FROM employment_countries WHERE org_id=? AND code=?",actor.org_id,code);
   if(old&&old.revision!==Number(data.revision))return fail(409,"Country settings changed. Refresh first.");
   await run(tx,`INSERT INTO employment_countries(org_id,code,name,currency,enabled,updated_by,updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(org_id,code) DO UPDATE SET name=excluded.name,currency=excluded.currency,enabled=excluded.enabled,revision=employment_countries.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,actor.org_id,code,str(data.name,"country name",100),currency,data.enabled===true,actor.id,now());
   await audit(tx,actor,"Employment country settings updated","employment country",code).run();
   return json({ok:true,message:"Employment country saved."});
  }
  if(action==="employment-region-save"){
   const country=pick(data.country,["CA","IN","PK"] as const,"country"),code=str(data.code,"region code",12).toUpperCase();
   if(!new RegExp(`^${country}-[A-Z0-9]{2,8}$`).test(code))return fail(400,"Region code must start with its country code.");
   const old=await one<{revision:number;country:string}>(tx,"SELECT revision,country FROM employment_regions WHERE org_id=? AND code=?",actor.org_id,code);
   if(old&&old.revision!==Number(data.revision))return fail(409,"Subdivision changed. Refresh first.");
   await run(tx,`INSERT INTO employment_regions(org_id,code,country,name,kind,enabled,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(org_id,code) DO UPDATE SET name=excluded.name,kind=excluded.kind,enabled=excluded.enabled,revision=employment_regions.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,actor.org_id,code,country,str(data.name,"subdivision name",120),pick(data.kind,["Province","State","Territory","Union territory","Capital territory","Federal","Other"],"jurisdiction type"),data.enabled===true,actor.id,now());
   await audit(tx,actor,"Employment subdivision updated","employment subdivision",code).run();
   return json({ok:true,message:"Employment subdivision saved."});
  }
  if(action==="employment-terms-save"){
   const employee=await one<Actor>(tx,"SELECT * FROM employees WHERE org_id=? AND id=? AND role<>'guest'",actor.org_id,str(data.employee,"employee",80));
   if(!employee)return fail(404,"Employee unavailable.");
   const effective=validDay(data.effectiveOn,"employment effective date");
   if(effective<localDate(now(),employee.time_zone))return fail(409,"New employment assignments must be effective today or later. Historical corrections require a reviewed payroll correction.");
   const country=pick(data.country,["CA","IN","PK"] as const,"country");
   const region=str(data.region,"workplace subdivision",12),jurisdiction=str(data.jurisdiction,"assessed employment jurisdiction",12);
   const selected=await all<{code:string;kind:string}>(tx,`SELECT r.code,r.kind FROM employment_regions r JOIN employment_countries c ON c.org_id=r.org_id AND c.code=r.country
    WHERE r.org_id=? AND r.country=? AND r.code IN (?,?) AND r.enabled AND c.enabled`,actor.org_id,country,region,jurisdiction);
   const workplace=selected.find(row=>row.code===region),legal=selected.find(row=>row.code===jurisdiction);
   if(!workplace||!legal)return fail(400,"Choose active, matching country and jurisdiction records.");
   if(workplace.kind==="Federal")return fail(400,"Choose the employee’s actual worksite subdivision separately from the assessed legal jurisdiction.");
   if(region!==jurisdiction&&!["Federal","Other"].includes(legal.kind))return fail(400,"Choose the worksite subdivision or an independently assessed federal or special legal jurisdiction.");
   const office=str(data.office,"office",80,false);
   if(office&&!await one(tx,"SELECT id FROM units WHERE org_id=? AND id=? AND kind='Office' AND country=?",actor.org_id,office,country))return fail(400,"Choose an office in the employee’s work country.");
   if(await one(tx,"SELECT id FROM staff_employment_terms WHERE employee_id=? AND effective_on=?",employee.id,effective))return fail(409,"An employment assignment already starts that day. Keep it for history and add a later assignment.");
   const currency=str(data.currency,"payroll currency",3).toUpperCase();if(!/^[A-Z]{3}$/.test(currency))return fail(400,"Enter the payroll currency code.");
   const target=id();
   await run(tx,`INSERT INTO staff_employment_terms(id,org_id,employee_id,effective_on,country,region_code,jurisdiction,classification,city,office_id,time_zone,employment_type,category,compensation_type,currency,frequency,expected_hours,schedule,reference,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,target,actor.org_id,employee.id,effective,country,region,jurisdiction,str(data.classification,"employment classification",120),str(data.city,"city",120),office||null,timeZone(data.timeZone),pick(data.employmentType,["Full-time","Part-time","Fixed-term","Contractor"],"employment type"),str(data.employeeCategory,"employee category",120),pick(data.compensationType,["Hourly","Salaried","Contract fee"],"compensation type"),currency,pick(data.frequency,["Weekly","Biweekly","Semimonthly","Monthly"],"pay frequency"),integer(data.expectedHours,"expected weekly hours",0,80),str(data.schedule,"work schedule",500),str(data.reference,"employment applicability evidence",2000),actor.id,now());
   await audit(tx,actor,`Effective employment assignment recorded for ${effective}`,"employment terms",target).run();
   return json({ok:true,message:"Effective employment assignment recorded. Unverified policies require review before use."},201);
  }
  if(action==="employment-policy-save"){
   const jurisdiction=str(data.jurisdiction,"jurisdiction",12),category=pick(data.category,employmentCategoryNames.filter(c=>c!=="Evidence"),"policy category");
   const region=await one<{country:string}>(tx,"SELECT country FROM employment_regions WHERE org_id=? AND code=?",actor.org_id,jurisdiction);
   if(!region)return fail(400,"Select a registered employment jurisdiction.");
   const from=validDay(data.effectiveFrom,"effective start"),through=validDay(data.effectiveThrough,"effective end");
   if(from>through)return fail(400,"The last effective day must follow the first.");
   let raw:unknown=["Work","Overtime"].includes(category)?(data.settings??data):data.settings;
   if(typeof raw==="string"){try{raw=JSON.parse(raw);}catch{return fail(400,"Enter valid JSON policy settings.");}}
   if(category==="Canada Alberta payroll"&&jurisdiction!=="CA-AB")return fail(400,"The maintained Alberta tax method is specific to CA-AB.");
   const settings=validateEmploymentSettings(category,raw),source=str(data.source,"official source",1500);
   let url:URL;try{url=new URL(source);}catch{return fail(400,"Enter an HTTPS official source URL.");}
   if(url.protocol!=="https:"||url.username||url.password||url.port)return fail(400,"Use an HTTPS official source.");
   const predecessor=str(data.predecessor,"previous version",80,false),classification=str(data.classification,"covered employment classification",120);
   if(predecessor){
    const previous=await one<EmploymentPolicy>(tx,"SELECT * FROM staff_jurisdiction_versions WHERE org_id=? AND id=?",actor.org_id,predecessor);
    if(!previous||previous.jurisdiction!==jurisdiction||previous.category!==category||previous.classification!==classification||from<=previous.effective_from||previous.mandatory&&data.mandatory!==true)return fail(400,"A replacement must retain coverage, begin later and preserve statutory status.");
   }
   const version=str(data.version,"unique version",80);
   if(await one(tx,"SELECT id FROM staff_jurisdiction_versions WHERE org_id=? AND jurisdiction=? AND classification=? AND version=?",actor.org_id,jurisdiction,classification,version))return fail(409,"Use a new version name.");
   const target=id();
   await run(tx,`INSERT INTO staff_jurisdiction_versions(id,org_id,country,jurisdiction,classification,version,effective_from,effective_through,source_url,evidence,created_by,created_at,category,settings,settings_hash,mandatory,predecessor_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,target,actor.org_id,region.country,jurisdiction,classification,version,from,through,url.href,str(data.evidence,"legal coverage and change reason",12000),actor.id,now(),category,JSON.stringify(settings),policyHash(settings),data.mandatory===true,predecessor||null);
   await audit(tx,actor,`Employment ${category} policy drafted`,"employment policy",target).run();
   return json({ok:true,message:"Policy version saved as PENDING LEGAL VERIFICATION. A separate administrator must review it."},201);
  }
  if(action==='employment-leave-adjust'){
   const employee=await one<Actor>(tx,"SELECT * FROM employees WHERE org_id=? AND id=? AND role<>'guest'",actor.org_id,str(data.employee,'employee',80));
   if(!employee)return fail(404,'Employee unavailable.');
   const day=validDay(data.effectiveOn,'leave adjustment date'),code=str(data.code,'leave category code',30),kind=pick(data.kind,['Opening balance','Correction','Carry forward'] as const,'adjustment type');
   const policy=await applicablePolicy(tx,employee,day,'Leave'),category=(policy!.settings as LeaveSettings).categories.find(c=>c.code===code);
   if(!category)return fail(400,'Choose a category from the verified leave policy.');
   const minutes=integer(data.minutes,'adjustment minutes',-525600,525600);
   if(!minutes||kind==='Carry forward'&&(minutes<0||minutes>category.carryMinutes))return fail(400,'Use a nonzero adjustment within the policy’s carry-forward limit.');
   const target=id();await run(tx,'INSERT INTO staff_leave_adjustments(id,org_id,employee_id,code,effective_on,minutes,kind,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',target,actor.org_id,employee.id,code,day,minutes,kind,str(data.reason,'verified correction or imported balance evidence',2000),actor.id,now());
   await audit(tx,actor,'Leave adjustment proposed','leave adjustment',target).run();
   return json({ok:true,message:'Leave adjustment submitted for independent review.'},201);
  }
  if(action==='employment-leave-adjust-review'){
   const target=str(data.id,'leave adjustment',80),row=await one<{created_by:string;employee_id:string}>(tx,'SELECT created_by,employee_id FROM staff_leave_adjustments WHERE org_id=? AND id=?',actor.org_id,target);
   if(!row)return fail(404,'Leave adjustment unavailable.');
   if(row.created_by===actor.id||row.employee_id===actor.id)return fail(403,'An independent administrator must review this adjustment.');
   if(await one(tx,'SELECT id FROM staff_leave_adjustment_reviews WHERE adjustment_id=?',target))return fail(409,'This adjustment already has a decision.');
   await run(tx,'INSERT INTO staff_leave_adjustment_reviews(id,adjustment_id,decision,reason,actor_id,created_at) VALUES(?,?,?,?,?,?)',id(),target,pick(data.decision,['Approved','Rejected'],'decision'),str(data.reason,'review evidence',2000),actor.id,now());
   await audit(tx,actor,'Leave adjustment reviewed','leave adjustment',target).run();
   return json({ok:true,message:'Leave adjustment decision recorded.'});
  }
  if(action==="employment-coverage"){
   const employee=await one<Actor>(tx,"SELECT * FROM employees WHERE org_id=? AND id=? AND role<>'guest'",actor.org_id,str(data.employee,"employee",80));
   if(!employee)return fail(404,"Employee unavailable.");
   const day=validDay(data.day,"calculation date"),terms=await employmentTermsOn(tx,employee,day);
   if(!terms)return json({ok:true,coverage:[],message:"No effective employment assignment covers this date."});
   const taxCategory=terms.country==="CA"?"Canada payroll":terms.country==="IN"?"India payroll":"Pakistan payroll";
   const categories:EmploymentCategory[]=["Work","Overtime","Holiday calendar","Leave","Pay standards",taxCategory];
   const coverage=await Promise.all(categories.map(async category=>{
    const policy=await applicablePolicy(tx,employee,day,category,false,
      category==="Canada payroll"?terms.region_code:undefined);
    if(policy)return {category,status:"Verified policy",version:policy.row.version,from:policy.row.effective_from,through:policy.row.effective_through,source:policy.row.source_url};
    if(category!==taxCategory)return {category,status:"Pending legal verification"};
    const packages=terms.country==="CA"
     ? maintainedCanadaTaxPackages().filter(entry=>"CA-"+entry.region?.code===terms.region_code)
     : nationalTaxPackages().filter(entry=>entry.country===terms.country);
    const current=packages.filter(entry=>day>=entry.validFrom&&day<=entry.validThrough);
    return {category,status:current.length?"Published package available · employee and employer review required":"Payment-date package required",
     version:current.map(entry=>entry.version).join(", "),source:current[0]?.source,from:current[0]?.validFrom,through:current[0]?.validThrough};
   }));
   return json({ok:true,coverage,assignment:{jurisdiction:terms.jurisdiction,workplace:terms.region_code,classification:terms.classification},message:"Coverage checked for "+day+"."});
  }
  return fail(404,"Employment action unavailable.");
 });
}
