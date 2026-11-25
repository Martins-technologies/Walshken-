import {D} from './payroll-money';
import {applicablePolicy,employmentTermsOn,policyDates,employmentPolicySegments,policyHash} from './employment-engine';
import type {LeaveCategory,LeaveSettings} from './employment-settings';
import {all,fail,one,type Actor,type Db} from './server';
import {dailySegments,dayAdd,type WorkBreak} from './attendance-rules';
import {workDataset} from './workforce';

type LeaveEmployee=Actor&{hire_date?:string|null};
type LeaveDay={day:string;minutes:number;policyId?:string;paid?:boolean};
type LeaveSnapshot={policyId:string;hash:string;settings:LeaveSettings;code:string;days?:LeaveDay[];rules?:{id:string;hash:string;assignmentId:string;from:string;through:string}[]};
type LeaveUse={id:string;starts_on:string;ends_on:string;entitlement_snapshot:string;status:string};
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
function savedMinutes(row:LeaveUse,code:string,from:string,to:string,holidays:Set<string>){
 const saved=JSON.parse(row.entitlement_snapshot) as LeaveSnapshot;
 if(saved.code!==code)return 0;
 if(saved.days)return saved.days.filter(day=>day.day>=from&&day.day<=to).reduce((sum,day)=>sum+day.minutes,0);
 return minutesInRange(row.starts_on>from?row.starts_on:from,row.ends_on<to?row.ends_on:to,saved.settings,holidays);
}
async function approvedWorkdays(db:Db,employee:LeaveEmployee,from:string,through:string){
 if(from>through)return new Set<string>();
 const intervals=await all<{id:string;starts_at:string;ends_at:string;time_zone:string;breaks:WorkBreak[]}>(db,`SELECT a.id,a.starts_at,a.ends_at,a.time_zone,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('starts_at',b.starts_at,'ends_at',b.ends_at,'paid',b.paid))
    FROM breaks b WHERE b.attendance_id=a.id AND b.voided_at IS NULL),'[]'::jsonb) AS breaks
  FROM timesheets t JOIN attendance a ON a.id=t.attendance_id AND a.employee_id=t.employee_id AND a.org_id=t.org_id
  WHERE t.org_id=? AND t.employee_id=? AND t.release_stage=? AND t.workflow_version=1 AND t.status='Approved'
  AND a.release_stage=t.release_stage AND a.starts_at<? AND a.ends_at>?`,employee.org_id,employee.id,workDataset(),dayAdd(through,2)+'T00:00:00.000Z',dayAdd(from,-1)+'T00:00:00.000Z');
 return new Set(intervals.flatMap(row=>dailySegments(row.starts_at,row.ends_at,row.breaks,row.time_zone).filter(segment=>segment.paid>0&&segment.day>=from&&segment.day<=through).map(segment=>segment.day)));
}

function earnedMinutes(category:LeaveCategory,settings:LeaveSettings,hire:string,day:string,from:string,to:string,worked:Set<string>){
 const first=hire>from?hire:from;
 if(first>day||countDays(hire,day)-1<category.minimumServiceDays)return 0;
 if(category.accrual==='Approved workdays'){
  if(worked.size<(category.minimumApprovedDays??0))return 0;
  return Math.min(category.annualMinutes,Math.floor(worked.size/category.daysPerCredit!)*settings.dayMinutes);
 }
 if(category.accrual==='Daily earned')return new D(category.annualMinutes).mul(countDays(first,day)).div(countDays(from,to)).floor().toNumber();
 if(category.accrual==='Monthly'){
  let completed=0;
  for(let month=from;month<=day;){
   if(month>=first)completed++;
   const d=new Date(month+'T12:00Z');d.setUTCMonth(d.getUTCMonth()+1,1);month=d.toISOString().slice(0,10);
  }
  return new D(category.annualMinutes).mul(completed).div(12).floor().toNumber();
 }
 return settings.proration==='Daily'?new D(category.annualMinutes).mul(countDays(first,to)).div(countDays(from,to)).floor().toNumber():category.annualMinutes;
}

export async function employeeLeaveBalances(db:Db,employee:LeaveEmployee,day:string,except='') {
 const rule=await applicablePolicy(db,employee,day,'Leave',false);
 if(!rule){
  if(await employmentTermsOn(db,employee,day))return fail(409,'Verify the leave policy before calculating entitlement.');
  return null;
 }
 const settings=rule.settings as LeaveSettings,{from,to}=cycle(day,settings.yearStartMonth),hire=String(employee.hire_date??'');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(hire))return fail(409,'Verify the actual hire date before calculating leave balances.');
 const earnedStart=[from,hire,rule.terms.effective_on].sort().at(-1)!;
 const variable=settings.categories.some(category=>['Daily earned','Approved workdays'].includes(category.accrual));
 const segments=variable&&earnedStart<=day?await employmentPolicySegments(db,employee,earnedStart,day,'Leave'):[];
 const [rows,adjustments,holidays,worked]=await Promise.all([
  all<LeaveUse>(db,`SELECT id,starts_on,ends_on,entitlement_snapshot,status FROM leave_requests
   WHERE org_id=? AND employee_id=? AND release_stage=? AND status IN('Pending','Approved') AND starts_on<=? AND ends_on>=? AND entitlement_snapshot IS NOT NULL`,employee.org_id,employee.id,workDataset(),to,from),
  all<{code:string;minutes:number;kind:string}>(db,`SELECT a.code,a.minutes,a.kind FROM staff_leave_adjustments a
   JOIN staff_leave_adjustment_reviews r ON r.adjustment_id=a.id AND r.decision='Approved'
   WHERE a.org_id=? AND a.employee_id=? AND a.effective_on BETWEEN ? AND ?`,employee.org_id,employee.id,from,day),
  policyDates(db,employee,from,to),
  settings.categories.some(category=>category.accrual==='Approved workdays')?approvedWorkdays(db,employee,earnedStart,day):new Set<string>(),
 ]);
 if(holidays.pending)return fail(409,'Verify holiday coverage before calculating leave balances.');
 const dates=new Set(holidays.dates.filter(h=>h.required).map(h=>h.day));
 const balances=settings.categories.map(category=>{
  let entitlement=earnedMinutes(category,settings,hire,day,from,to,worked);
  if(category.accrual==='Daily earned'||category.accrual==='Approved workdays'){
   let prorated=new D(0);
   const threshold=category.minimumApprovedDays??0;
   for(const segment of segments){
    const historic=segment.policy.settings as LeaveSettings,previous=historic.categories.find(item=>item.code===category.code);
    if(!previous||historic.yearStartMonth!==settings.yearStartMonth||previous.accrual!==category.accrual
      ||previous.paid!==category.paid||previous.minimumServiceDays!==category.minimumServiceDays
      ||category.accrual==='Approved workdays'&&(previous.annualMinutes!==category.annualMinutes||previous.daysPerCredit!==category.daysPerCredit||previous.minimumApprovedDays!==threshold||historic.dayMinutes!==settings.dayMinutes))
      return fail(409,'Review the opening leave balance where the accrual basis or cycle changes.');
    const eligibleDay=dayAdd(hire,category.minimumServiceDays),start=segment.from>eligibleDay?segment.from:eligibleDay;
    if(start<=segment.through)prorated=prorated.add(new D(previous.annualMinutes).mul(countDays(start,segment.through)).div(countDays(from,to)));
   }
   if(category.accrual==='Daily earned')entitlement=prorated.floor().toNumber();
  }
  const adjustment=adjustments.filter(a=>a.code===category.code).reduce((sum,a)=>sum+a.minutes,0);
  let used=0,pending=0;
  for(const row of rows){
   if(row.id===except&&row.status==='Pending')continue;
   const minutes=savedMinutes(row,category.code,from,to,dates);
   if(row.status==='Approved')used+=minutes;else pending+=minutes;
  }
  return {...category,entitlement,adjustment,used,pending,available:entitlement+adjustment-used-pending,from,to,policyId:rule.row.id};
 });
 return {balances,settings,rule:rule.row,assignment:rule.terms};
}

export function payrollLeaveEntitlement(snapshot:string|null,day:string){
 if(!snapshot)return null;
 const saved=JSON.parse(snapshot) as LeaveSnapshot;
 if(!saved.days)return null;
 const allocation=saved.days.find(entry=>entry.day===day);
 if(!allocation)return fail(409,'The approved leave snapshot has no payable or unpaid allocation on this date.');
 const paid=allocation.paid??saved.settings.categories.find(category=>category.code===saved.code)?.paid;
 if(typeof paid!=='boolean')return fail(409,'The approved leave record has no verified paid classification.');
 return {paid,seconds:allocation.minutes*60};
}

export function sameLeaveEntitlement(saved:LeaveSnapshot,current:LeaveSnapshot){
 if(saved.hash!==current.hash||saved.code!==current.code||saved.policyId!==current.policyId)return false;
 const signature=(snapshot:LeaveSnapshot)=>JSON.stringify(snapshot.days?.map(day=>[day.day,day.minutes]));
 return !saved.days||signature(saved)===signature(current);
}

export async function validateLeaveRequest(db:Db,employee:LeaveEmployee,from:string,to:string,code:string,except=''){
 if(to<from||to>dayAdd(from,366))return fail(400,'Choose a leave interval up to one year.');
 if(!await employmentTermsOn(db,employee,from)){
  if(await employmentTermsOn(db,employee,to))return fail(409,'Start the request at the employment assignment’s effective date.');
  return null;
 }
 const segments=await employmentPolicySegments(db,employee,from,to,'Leave');
 const first=segments[0].policy;
 const initialSettings=first.settings as LeaveSettings;
 const name=initialSettings.categories.find(category=>category.code===code)?.name;
 if(!name)return fail(400,'Choose a leave category from the employee’s verified policy.');
 const dates=await policyDates(db,employee,from,to);
 if(dates.pending)return fail(409,'Verify the holiday calendar before requesting leave.');
 const holidays=new Set(dates.dates.filter(h=>h.required).map(h=>h.day));
 const days:LeaveDay[]=[],charged=new Map<string,number>();
 const rules=segments.map(({from,through,policy})=>({id:policy.row.id,hash:policy.row.settings_hash,assignmentId:policy.terms.id,from,through}));
 for(const segment of segments){
  const settings=segment.policy.settings as LeaveSettings;
  const category=settings.categories.find(item=>item.code===code);
  if(!category||settings.yearStartMonth!==initialSettings.yearStartMonth)return fail(409,'Split leave where the entitlement category or cycle changes.');
  if(segment.policy.terms.id!==first.terms.id)return fail(409,'Split leave at the effective employment assignment date.');
  for(let start=segment.from;start<=segment.through;){
   const period=cycle(start,settings.yearStartMonth),end=segment.through<period.to?segment.through:period.to;
   const minutes=minutesInRange(start,end,settings,holidays);
   const total=(charged.get(period.from)??0)+minutes;
   const balance=await employeeLeaveBalances(db,employee,start,except);
   const selected=balance!.balances.find(item=>item.code===code)!;
   if(total>selected.available)return fail(409,'The requested leave exceeds the available verified balance for '+category.name+'.');
   charged.set(period.from,total);
   for(let day=start;day<=end;day=dayAdd(day,1)){
    const amount=minutesInRange(day,day,settings,holidays);
    if(amount)days.push({day,minutes:amount,policyId:segment.policy.row.id,paid:category.paid});
   }
   start=dayAdd(end,1);
  }
 }
 const minutes=days.reduce((sum,day)=>sum+day.minutes,0);
 if(!minutes)return fail(400,'The interval has no scheduled leave days.');
 const hash=segments.length>1?policyHash({rules,days}):first.row.settings_hash;
 return {minutes,name,snapshot:JSON.stringify({policyId:first.row.id,hash,settings:initialSettings,code,days,rules} satisfies LeaveSnapshot)};
}

export async function closingLeaveCarry(db:Db,employee:LeaveEmployee,cycleStart:string,code:string,exclude=''){
 const incoming=await employeeLeaveBalances(db,employee,cycleStart),outgoing=await employeeLeaveBalances(db,employee,dayAdd(cycleStart,-1));
 const next=incoming?.balances.find(row=>row.code===code),previous=outgoing?.balances.find(row=>row.code===code);
 if(!next||next.from!==cycleStart||!next.reviewCarry||!previous||dayAdd(previous.to,1)!==cycleStart)
  return fail(409,'Choose a verified leave category with calculated carry enabled and enter the first day of its new leave year.');
 if(incoming!.assignment.id!==outgoing!.assignment.id||next.paid!==previous.paid)
  return fail(409,'Use a reviewed carry adjustment when employment or the paid status changes between cycles.');
 if(previous.pending>0)return fail(409,'Resolve last year’s pending leave requests before calculating carry-forward.');
 const existing=await one(db,`SELECT a.id FROM staff_leave_adjustments a LEFT JOIN staff_leave_adjustment_reviews r ON r.adjustment_id=a.id
  WHERE a.org_id=? AND a.employee_id=? AND a.code=? AND a.kind='Carry forward' AND a.effective_on BETWEEN ? AND ?
  AND a.id<>? AND COALESCE(r.decision,'Pending')<>'Rejected' LIMIT 1`,employee.org_id,employee.id,code,next.from,next.to,exclude);
 if(existing)return fail(409,'A carry-forward is already pending or approved for this employee, category and leave year.');
 const minutes=Math.min(next.carryMinutes,Math.max(0,previous.available));
 if(minutes===0)return fail(409,'No unused entitlement qualifies for carry-forward.');
 return {minutes,from:previous.from,through:previous.to,previous:previous.available,cap:next.carryMinutes,
  outgoingPolicy:outgoing!.rule.id,outgoingHash:outgoing!.rule.settings_hash,incomingPolicy:incoming!.rule.id,incomingHash:incoming!.rule.settings_hash};
}
