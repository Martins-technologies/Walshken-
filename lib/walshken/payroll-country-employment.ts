import {applicablePolicy,policyDates} from './employment-engine';
import type {PayStandards} from './employment-settings';
import {D,toMinor} from './payroll-money';
import {dayAdd} from './attendance-rules';
import {fail,now,one,type Actor,type Db} from './server';
import {hash,payrollDataset,rateOn,type PayrollEmployee} from './payroll-access';
import {hourlyMinor,wages,week,type DayWork} from './payroll-work';
import {nativeEngines} from './payroll-statutory';
import type {PayItem,PayPeriod,PayPolicy,PayRate} from './payroll-types';
export type CountryEmploymentContext={rules:{id:string;version:string;hash:string;source:string};standards:PayStandards;events:{day:string;name:string;required:boolean}[];decisions:PayItem[];snapshots:{day:string;eligible:boolean;basis:number;days:number;amount:number;policyId:string;hash:string}[]};
export async function countryEmploymentContext(db:Db,actor:Actor,employee:PayrollEmployee,period:PayPeriod,policy:PayPolicy,work:DayWork[],rates:PayRate[]):Promise<CountryEmploymentContext|null>{
 if(policy.classification==='Contractor')return null;
 const optional=employee.jurisdiction==='CA-AB'||!nativeEngines.includes(policy.taxEngine as typeof nativeEngines[number]);
 const active=await applicablePolicy(db,employee,period.starts_on,'Pay standards',!optional);
 if(!active||optional&&!active.settings.companyConfigured)return null;
 const end=await applicablePolicy(db,employee,period.ends_on,'Pay standards');if(active!.row.id!==end!.row.id)return fail(409,'Pay standards change within this period; calculate each effective segment in its corresponding pay period.');
 const standards=active!.settings as PayStandards;if(standards.currency!==policy.currency)return fail(409,'Pay standards must use the employment currency.');
 // A change of calculation method must not discard an already approved
 // deferred benefit earned under the previous holiday engine.
 if(employee.jurisdiction==='CA-AB'&&standards.companyConfigured&&await one(db,`SELECT a.id FROM holiday_assessments a
  WHERE a.employee_id=? AND a.release_stage=? AND a.status='Approved'
  AND (a.configuration::jsonb)#>>'{facts,method}'<>'Pay now'
  AND COALESCE(((a.configuration::jsonb)#>>'{facts,dayPayMinor}')::numeric,0)>0
  AND (((a.configuration::jsonb)#>>'{facts,payDay}') BETWEEN ? AND ? OR (? BETWEEN ? AND ? AND (a.configuration::jsonb)#>>'{facts,payDay}'>?))
  AND NOT EXISTS(SELECT 1 FROM holiday_assessments n WHERE n.employee_id=a.employee_id AND n.release_stage=a.release_stage AND n.holiday_date=a.holiday_date AND n.status='Approved' AND (n.created_at,n.id)>(a.created_at,a.id))
  AND NOT EXISTS(SELECT 1 FROM holiday_allocations l WHERE l.employee_id=a.employee_id AND l.release_stage=a.release_stage AND l.holiday_date=a.holiday_date AND l.component='Day pay') LIMIT 1`,employee.id,payrollDataset(),period.starts_on,period.ends_on,employee.employment_end??'',period.starts_on,period.ends_on,employee.employment_end??''))return fail(409,'A previously approved deferred holiday payment is due in this period. Settle or independently review that existing obligation before starting a different holiday calculation policy.');
 const calendar=await policyDates(db,employee,period.starts_on,period.ends_on);if(!calendar.configured||calendar.pending)return fail(409,'Review applicable statutory holiday calendar coverage before payroll.');
 const decisions:PayItem[]=[],snapshots:CountryEmploymentContext['snapshots']=[];
 for(const holiday of calendar.dates.filter(h=>h.required)){
  if(holiday.day<employee.hire_date||employee.employment_end&&holiday.day>employee.employment_end)continue;
  const from=standards.holidayWindowBasis==='Complete workweeks'?dayAdd(week(holiday.day,policy.workweekStart),-standards.holidayWindowDays):dayAdd(holiday.day,-standards.holidayWindowDays),through=standards.holidayWindowBasis==='Complete workweeks'?dayAdd(week(holiday.day,policy.workweekStart),-1):dayAdd(holiday.day,-1);
  const historical=work.filter(d=>d.day>=from&&d.day<=through&&d.sheet.status==='Approved');
  const current=work.filter(d=>d.day===holiday.day&&d.sheet.status==='Approved');
  const service=Math.floor((Date.parse(holiday.day)-Date.parse(employee.hire_date))/86400000),days=new Set(historical.filter(d=>d.paid>0).map(d=>d.day)).size;
   const eligibilityStart=new Date(holiday.day+'T12:00Z');if(standards.eligibilityLookbackMonths!==undefined)eligibilityStart.setUTCMonth(eligibilityStart.getUTCMonth()-standards.eligibilityLookbackMonths);
  const eligibilityHistory=standards.eligibilityLookbackMonths===undefined?historical:work.filter(d=>d.day>=eligibilityStart.toISOString().slice(0,10)&&d.day<holiday.day&&d.paid>0&&d.sheet.status==='Approved'),eligibilityDays=new Set(eligibilityHistory.filter(d=>d.paid>0).map(d=>d.day)).size;
  const weekday=new Date(holiday.day+'T12:00Z').getUTCDay(),occurrences=standards.regularDayLookbackWeeks===undefined?0:new Set(work.filter(d=>d.sheet.status==='Approved'&&d.paid>0&&d.day>=dayAdd(holiday.day,-standards.regularDayLookbackWeeks!*7)&&d.day<holiday.day&&new Date(d.day+'T12:00Z').getUTCDay()===weekday).map(d=>d.day)).size;
  const regularDay=policy.workdays.includes(weekday)||standards.holidayPayOnNonWorkday||standards.regularDayMinimumOccurrences!==undefined&&occurrences>=standards.regularDayMinimumOccurrences;
  const eligible=service>=standards.minimumServiceDays&&eligibilityDays>=standards.minimumWorkedDays&&(!standards.companyConfigured||regularDay||current.some(d=>d.paid>0));
  let basis=0;for(const day of historical){const rate=rateOn(rates,day.day);basis+=wages(rate,day.regular,policy);}
  const rate=rateOn(rates,holiday.day),normal=wages(rate,policy.regularWeekHours*3600/policy.workdays.length,policy),amount=!eligible||standards.companyConfigured&&!regularDay?0:standards.holidayMethod==='Normal day'?normal:standards.holidayMethod==='Percent of earnings'?new D(basis).mul(standards.holidayPercent).div(100).toDecimalPlaces(0).toNumber():new D(basis).div(standards.holidayDivisor||days||1).toDecimalPlaces(0).toNumber();
  if(eligible&&(!standards.companyConfigured||regularDay)&&standards.holidayMethod!=='Normal day'&&!(standards.holidayMethod==='Percent of earnings'&&new D(standards.holidayPercent).eq(0))&&!historical.length)return fail(409,'Historical approved earnings are required for '+holiday.name+'; import and approve the employee’s work history before this calculation.');
  const snapshot={day:holiday.day,eligible,basis,days,amount,policyId:active!.row.id,hash:hash({policy:active!.row.settings_hash,work:historical.map(d=>({id:d.sheet.id,revision:d.sheet.revision,day:d.day,regular:d.regular,rate:rateOn(rates,d.day).id})),rate:rate.id,current:current.map(d=>d.sheet.id),...(standards.eligibilityLookbackMonths!==undefined?{eligibility:eligibilityHistory.map(d=>({id:d.sheet.id,revision:d.sheet.revision,day:d.day,paid:d.paid}))}:{}),...(standards.regularDayLookbackWeeks!==undefined?{occurrences,regularDay}:{})})};snapshots.push(snapshot);
  decisions.push({id:'country-holiday:'+employee.id+':'+holiday.day,employee_id:employee.id,period_id:period.id,kind:'Holiday decision',label:holiday.name,amount_minor:amount,currency:policy.currency,minor_unit:2,work_date:holiday.day,seconds:eligible?policy.regularWeekHours*3600/policy.workdays.length:0,non_periodic:0,taxable:1,pensionable:1,insurable:1,vacationable:0,pretax:0,related_id:null,detail:JSON.stringify({eligible,regularDay,guaranteedMinor:amount,premium:current.length>0,required:true,reference:active!.row.source_url,ruleVersion:active!.row.version,sourceHash:snapshot.hash}),status:'Approved',created_by:active!.row.created_by,approved_by:null,revision:1,review_note:standards.companyConfigured?'Calculated from independently reviewed company policy':'Calculated from independently verified policy'});
 }
 return {rules:{id:active!.row.id,version:active!.row.version,hash:active!.row.settings_hash,source:active!.row.source_url},standards,events:calendar.dates.filter(h=>h.required),decisions,snapshots};
}
export async function finalizeCountryHolidayAllocations(db:Db,actor:Actor,payrollId:string,context:CountryEmploymentContext,employee:string){
 const {run,id}=await import('./server');
 for(const snapshot of context.snapshots)await run(db,'INSERT INTO staff_country_holiday_allocations(id,org_id,employee_id,payroll_id,release_stage,holiday_date,amount_minor,snapshot,created_at) VALUES(?,?,?,?,?,?,?,?,?)',id(),actor.org_id,employee,payrollId,payrollDataset(),snapshot.day,snapshot.amount,JSON.stringify({...snapshot,rules:context.rules}),now());
}
