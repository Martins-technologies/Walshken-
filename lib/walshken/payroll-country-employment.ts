import {policyForPeriod,policyDates} from './employment-engine';
import type {PayStandards} from './employment-settings';
import {D,toMinor} from './payroll-money';
import {dayAdd} from './attendance-rules';
import {fail,now,type Actor,type Db} from './server';
import {hash,payrollDataset,rateOn,type PayrollEmployee} from './payroll-access';
import {hourlyMinor,wages,week,type DayWork} from './payroll-work';
import {nativeEngines} from './payroll-statutory';
import type {PayItem,PayPeriod,PayPolicy,PayRate} from './payroll-types';
export type CountryEmploymentContext={rules:{id:string;version:string;hash:string;source:string};standards:PayStandards;events:{day:string;name:string;required:boolean}[];decisions:PayItem[];snapshots:{day:string;eligible:boolean;basis:number;days:number;amount:number;policyId:string;hash:string}[]};
export async function countryEmploymentContext(db:Db,actor:Actor,employee:PayrollEmployee,period:PayPeriod,policy:PayPolicy,work:DayWork[],rates:PayRate[]):Promise<CountryEmploymentContext|null>{
 if(policy.classification==='Contractor'||!nativeEngines.includes(policy.taxEngine as typeof nativeEngines[number])||employee.jurisdiction==='CA-AB')return null;
 const active=await policyForPeriod(db,employee,period.starts_on,period.ends_on,'Pay standards');
 const standards=active!.settings as PayStandards;if(standards.currency!==policy.currency)return fail(409,'Pay standards must use the employment currency.');
 if(period.pay_date>dayAdd(period.ends_on,standards.paymentDeadlineDays)&&!employee.employment_end)return fail(409,'The payment date exceeds the verified jurisdiction payment deadline.');
 const calendar=await policyDates(db,employee,period.starts_on,period.ends_on);if(!calendar.configured||calendar.pending)return fail(409,'Review applicable statutory holiday calendar coverage before payroll.');
 const decisions:PayItem[]=[],snapshots:CountryEmploymentContext['snapshots']=[];
 for(const holiday of calendar.dates.filter(h=>h.required)){
  if(holiday.day<employee.hire_date||employee.employment_end&&holiday.day>employee.employment_end)continue;
  const from=standards.holidayWindowBasis==='Complete workweeks'?dayAdd(week(holiday.day,policy.workweekStart),-standards.holidayWindowDays):dayAdd(holiday.day,-standards.holidayWindowDays),through=standards.holidayWindowBasis==='Complete workweeks'?dayAdd(week(holiday.day,policy.workweekStart),-1):dayAdd(holiday.day,-1);
  const historical=work.filter(d=>d.day>=from&&d.day<=through&&d.sheet.status==='Approved');
  const current=work.filter(d=>d.day===holiday.day&&d.sheet.status==='Approved');
  const service=Math.floor((Date.parse(holiday.day)-Date.parse(employee.hire_date))/86400000),days=new Set(historical.filter(d=>d.paid>0).map(d=>d.day)).size;
  const eligible=service>=standards.minimumServiceDays&&days>=standards.minimumWorkedDays;
  let basis=0;for(const day of historical){const rate=rateOn(rates,day.day);basis+=wages(rate,day.regular,policy);}
  const rate=rateOn(rates,holiday.day),normal=wages(rate,policy.regularWeekHours*3600/policy.workdays.length,policy),amount=!eligible?0:standards.holidayMethod==='Normal day'?normal:standards.holidayMethod==='Percent of earnings'?new D(basis).mul(standards.holidayPercent).div(100).toDecimalPlaces(0).toNumber():new D(basis).div(standards.holidayDivisor||days||1).toDecimalPlaces(0).toNumber();
  if(eligible&&standards.holidayMethod!=='Normal day'&&!historical.length)return fail(409,'Historical approved earnings are required for '+holiday.name+'; import and approve the employee’s work history before this calculation.');
  const snapshot={day:holiday.day,eligible,basis,days,amount,policyId:active!.row.id,hash:hash({policy:active!.row.settings_hash,work:historical.map(d=>({id:d.sheet.id,revision:d.sheet.revision,day:d.day,regular:d.regular,rate:rateOn(rates,d.day).id})),rate:rate.id,current:current.map(d=>d.sheet.id)})};snapshots.push(snapshot);
  decisions.push({id:'country-holiday:'+employee.id+':'+holiday.day,employee_id:employee.id,period_id:period.id,kind:'Holiday decision',label:holiday.name,amount_minor:amount,currency:policy.currency,minor_unit:2,work_date:holiday.day,seconds:eligible?policy.regularWeekHours*3600/policy.workdays.length:0,non_periodic:0,taxable:1,pensionable:1,insurable:1,vacationable:0,pretax:0,related_id:null,detail:JSON.stringify({eligible,regularDay:policy.workdays.includes(new Date(holiday.day+'T12:00Z').getUTCDay())||standards.holidayPayOnNonWorkday,guaranteedMinor:amount,premium:current.length>0,required:true,reference:active!.row.source_url,ruleVersion:active!.row.version,sourceHash:snapshot.hash}),status:'Approved',created_by:active!.row.created_by,approved_by:null,revision:1,review_note:'Calculated from independently verified policy'});
 }
 return {rules:{id:active!.row.id,version:active!.row.version,hash:active!.row.settings_hash,source:active!.row.source_url},standards,events:calendar.dates.filter(h=>h.required),decisions,snapshots};
}
export async function finalizeCountryHolidayAllocations(db:Db,actor:Actor,payrollId:string,context:CountryEmploymentContext,employee:string){
 const {run,id}=await import('./server');
 for(const snapshot of context.snapshots)await run(db,'INSERT INTO staff_country_holiday_allocations(id,org_id,employee_id,payroll_id,release_stage,holiday_date,amount_minor,snapshot,created_at) VALUES(?,?,?,?,?,?,?,?,?)',id(),actor.org_id,employee,payrollId,payrollDataset(),snapshot.day,snapshot.amount,JSON.stringify({...snapshot,rules:context.rules}),now());
}
