import {D} from './payroll-money';
import {applicablePolicy,employmentTermsOn,policyDates} from './employment-engine';
import type {LeaveSettings} from './employment-settings';
import {all,fail,type Actor,type Db} from './server';
import {dayAdd} from './attendance-rules';
import {workDataset} from './workforce';

type LeaveEmployee=Actor&{hire_date?:string|null};
type LeaveSnapshot={policyId:string;hash:string;settings:LeaveSettings;code:string;days?:{day:string;minutes:number}[]};
function cycle(day:string,month:number){
 let year=Number(day.slice(0,4));const suffix=String(month).padStart(2,'0')+'-01';
 if(day.slice(5)<suffix)year--;
 return {from:year+'-'+suffix,to:dayAdd((year+1)+'-'+suffix,-1)};
}
const countDays=(from:string,to:string)=>Math.round((Date.parse(to)-Date.parse(from))/86400000)+1;
function minutesInRange(from:string,to:string,settings:LeaveSettings,holidays:Set<string>){
 let total=0;
 for(let day=from;day<=to;day=dayAdd(day,1))if(settings.workdays.includes(new Date(day+'T12:00Z').getUTCDay())&&!holidays.has(day))total+=settings.dayMinutes;
 return total;
}
export async function employeeLeaveBalances(db:Db,employee:LeaveEmployee,day:string) {
 if(!await employmentTermsOn(db,employee,day))return null;
 const rule=await applicablePolicy(db,employee,day,'Leave'),settings=rule!.settings as LeaveSettings;
 const {from,to}=cycle(day,settings.yearStartMonth),hire=String(employee.hire_date??'');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(hire))return fail(409,'Verify the actual hire date before calculating leave balances.');
 const rows=await all<{id:string;starts_on:string;ends_on:string;entitlement_snapshot:string;status:string}>(db,`SELECT id,starts_on,ends_on,entitlement_snapshot,status FROM leave_requests
  WHERE org_id=? AND employee_id=? AND release_stage=? AND status IN('Pending','Approved') AND starts_on<=? AND ends_on>=? AND entitlement_snapshot IS NOT NULL`,employee.org_id,employee.id,workDataset(),to,from);
 const adjustments=await all<{code:string;minutes:number;kind:string}>(db,`SELECT a.code,a.minutes,a.kind FROM staff_leave_adjustments a
  JOIN staff_leave_adjustment_reviews r ON r.adjustment_id=a.id AND r.decision='Approved'
  WHERE a.org_id=? AND a.employee_id=? AND a.effective_on BETWEEN ? AND ?`,employee.org_id,employee.id,from,day);
 const holidays=await policyDates(db,employee,from,to);
 if(holidays.pending)return fail(409,'Verify holiday coverage before calculating leave balances.');
 const dates=new Set(holidays.dates.filter(h=>h.required).map(h=>h.day));
 const balances=settings.categories.map(category=>{
  const service=countDays(hire,day)-1,eligible=service>=category.minimumServiceDays;
  let entitlement=0;
  const first=hire>from?hire:from;
  if(eligible&&first<=day){
   if(category.accrual==='Monthly'){
    let completed=0;
    for(let month=from;month<=day;){
     if(month>=first)completed++;
     const d=new Date(month+'T12:00Z');d.setUTCMonth(d.getUTCMonth()+1,1);month=d.toISOString().slice(0,10);
    }
    entitlement=new D(category.annualMinutes).mul(completed).div(12).floor().toNumber();
   }else entitlement=settings.proration==='Daily'?new D(category.annualMinutes).mul(countDays(first,to)).div(countDays(from,to)).floor().toNumber():category.annualMinutes;
  }
  const adjustment=adjustments.filter(a=>a.code===category.code).reduce((sum,a)=>sum+a.minutes,0);
  let used=0,pending=0;
  for(const leave of rows){
   const saved=JSON.parse(leave.entitlement_snapshot) as LeaveSnapshot;
   if(saved.code!==category.code)continue;
   const minutes=saved.days?saved.days.filter(entry=>entry.day>=from&&entry.day<=to).reduce((total,entry)=>total+entry.minutes,0):minutesInRange(leave.starts_on>from?leave.starts_on:from,leave.ends_on<to?leave.ends_on:to,saved.settings,dates);
   if(leave.status==='Approved')used+=minutes;else pending+=minutes;
  }
  return {...category,entitlement,adjustment,used,pending,available:entitlement+adjustment-used-pending,from,to,policyId:rule!.row.id};
 });
 return {balances,settings,rule:rule!.row};
}
export async function validateLeaveRequest(db:Db,employee:LeaveEmployee,from:string,to:string,code:string,except=''){
 if(to<from||to>dayAdd(from,366))return fail(400,'Choose a leave interval up to one year.');
 if(!await employmentTermsOn(db,employee,from))return null;
 const first=await applicablePolicy(db,employee,from,'Leave'),last=await applicablePolicy(db,employee,to,'Leave');
 if(first!.row.id!==last!.row.id)return fail(409,'Split this leave request at the policy change date.');
 const settings=first!.settings as LeaveSettings,category=settings.categories.find(c=>c.code===code);
 if(!category)return fail(400,'Choose a leave category from the employee’s verified policy.');
 const dates=await policyDates(db,employee,from,to);
 if(dates.pending)return fail(409,'Verify the holiday calendar before requesting leave.');
 const holidays=new Set(dates.dates.filter(h=>h.required).map(h=>h.day));
 const minutes=minutesInRange(from,to,settings,holidays);
 if(!minutes)return fail(400,'The interval has no scheduled leave days.');
 for(let day=from;day<=to;){
  const balance=await employeeLeaveBalances(db,employee,day),period=cycle(day,settings.yearStartMonth);
  const selected=balance!.balances.find(b=>b.code===code)!;
  let restore=0;
  if(except){
   const self=await all<{starts_on:string;ends_on:string}>(db,"SELECT starts_on,ends_on FROM leave_requests WHERE id=? AND employee_id=? AND status='Pending'",except,employee.id);
   for(const entry of self)restore+=minutesInRange(entry.starts_on>period.from?entry.starts_on:period.from,entry.ends_on<period.to?entry.ends_on:period.to,settings,holidays);
  }
  const end=to<period.to?to:period.to;
  if(minutesInRange(day,end,settings,holidays)>selected.available+restore)return fail(409,'The requested leave exceeds the available verified balance for '+selected.name+'.');
  day=dayAdd(end,1);
 }
 const days=[];for(let day=from;day<=to;day=dayAdd(day,1)){const amount=minutesInRange(day,day,settings,holidays);if(amount)days.push({day,minutes:amount});}
 return {minutes,name:category.name,snapshot:JSON.stringify({policyId:first!.row.id,hash:first!.row.settings_hash,settings,code,days} satisfies LeaveSnapshot)};
}
