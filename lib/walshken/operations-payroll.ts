import {all,fail,type Actor,type Db} from './server';
import {controlsEnabled} from './capabilities';
import {approvedOperations,ledger,operationsStage,operationsSettings,type OperationRequest} from './operations-store';
import {dailySegments,dayAdd,totals,type WorkBreak} from './attendance-rules';
import {localDate} from './work';
import {hourlyMinor,sum,wages,week,type DayWork} from './payroll-work';
import {D} from './payroll-money';
import {rateOn,type PayrollEmployee} from './payroll-access';
import type {PayCalculation,PayLine,PayPeriod,PayPolicy,PayRate} from './payroll-types';
export function activeArrangement(requests:OperationRequest[],kind:string,day:string){return requests.find(r=>r.kind===kind&&r.effective_on<=day&&r.through_date>=day&&!requests.some(w=>w.kind==='Withdraw arrangement'&&JSON.parse(w.configuration).requestId===r.id&&w.effective_on<=day));}
export async function operationsPayrollFacts(db:Db,actor:Actor,employee:string,p:PayPeriod){if(!controlsEnabled())return null;return {approvalPolicy:(await operationsSettings(db,actor)).settings,requests:await approvedOperations(db,actor,employee,p.ends_on),entries:await all<BankEntry>(db,"SELECT * FROM operations_ledger WHERE org_id=? AND release_stage=? AND employee_id=? AND effective_on<=? AND source_id NOT LIKE ? ORDER BY effective_on,created_at,id",actor.org_id,operationsStage(),employee,p.ends_on,p.id+':%')};}
export type BankEntry={id:string;source_id:string;kind:string;effective_on:string;due_on:string|null;seconds:number;amount_minor:number;currency:string;detail:string};
export function bankAvailable(entries:BankEntry[]){const credits=entries.filter(e=>e.kind==='Overtime credit').map(e=>({...e,remaining:e.seconds}));for(const debit of entries.filter(e=>['Overtime leave','Overtime settlement'].includes(e.kind))){const allocations=JSON.parse(debit.detail).allocations??[];for(const a of allocations){const c=credits.find(c=>c.id===a.creditId);if(c)c.remaining-=a.seconds;}}return credits.filter(c=>c.remaining>0);}
export function assignAveraging(days:DayWork[],requests:OperationRequest[],p:PayPeriod){
 const settlements:{day:string;rateDay:string;seconds:number;requestId:string}[]=[];
 for(const arrangement of requests.filter(r=>r.kind==='Averaging arrangement'&&r.effective_on<=p.ends_on&&r.through_date>=dayAdd(p.starts_on,-364))){
  const c=JSON.parse(arrangement.configuration),rows=days.filter(d=>d.day>=arrangement.effective_on&&d.day<=arrangement.through_date&&d.sheet.status==='Approved'&&!d.holiday),group=new Map<string,DayWork[]>();
  for(const row of rows){row.regular=row.paid;row.ot=0;const list=group.get(row.day)??[];list.push(row);group.set(row.day,list);}
  for(const [day,list]of group){const offset=Math.round((Date.parse(day+'T12:00Z')-Date.parse(arrangement.effective_on+'T12:00Z'))/86400000),threshold=c.dailyOvertime==='No daily threshold'?Infinity:Math.max(8,c.schedule[offset])*3600;let left=Math.max(0,sum(list.map(d=>d.paid))-threshold);for(const row of [...list].reverse()){row.ot=Math.min(left,row.paid);row.regular=row.paid-row.ot;left-=row.ot;}}
  if(arrangement.through_date>=p.starts_on&&arrangement.through_date<=p.ends_on){
   if(days.some(d=>d.day>=arrangement.effective_on&&d.day<=arrangement.through_date&&d.sheet.status!=='Approved'))return fail(409,'Approve all recorded time in the averaging cycle before its closing payroll.');
   const actual=sum(rows.map(d=>d.paid)),daily=sum(rows.map(d=>d.ot)),extra=Math.max(0,actual-c.weeks*44*3600-daily);let remaining=extra;for(const row of [...rows].sort((a,b)=>b.day.localeCompare(a.day))){const seconds=Math.min(remaining,row.regular);if(seconds)settlements.push({day:arrangement.through_date,rateDay:row.day,seconds,requestId:arrangement.id});remaining-=seconds;if(!remaining)break;}
  }
 }
 return settlements;
}
export function reportingPayLines(employee:PayrollEmployee,p:PayPeriod,policy:PayPolicy,rates:PayRate[],work:{daily:DayWork[];breaks:(WorkBreak&{attendance_id:string})[]},requests:OperationRequest[],minimumHourly=1500){
 const lines:PayLine[]=[];if(!controlsEnabled()||policy.classification!=='Employee'||employee.jurisdiction!=='CA-AB'||rateOn(rates,p.starts_on).rate_unit!=='Hour')return lines;
 const sheets=[...new Map(work.daily.map(d=>[d.sheet.id,d.sheet])).values()];
 for(const sheet of sheets){
  if(sheet.status!=='Approved')continue;const bs=work.breaks.filter(b=>b.attendance_id===sheet.attendance_id),split=bs.filter(b=>!b.paid&&b.ends_at&&Date.parse(b.ends_at)-Date.parse(b.starts_at)>3600000).sort((a,b)=>a.starts_at.localeCompare(b.starts_at));let start=sheet.starts_at;const intervals:{start:string;end:string}[]=[];
  for(const b of split){if(b.starts_at>start)intervals.push({start,end:b.starts_at});start=b.ends_at!;}if(sheet.ends_at>start)intervals.push({start,end:sheet.ends_at});
  const approved=[...requests].reverse().find(r=>r.kind==='Reporting classification'&&JSON.parse(r.configuration).attendanceId===sheet.attendance_id),classification=approved?JSON.parse(approved.configuration):{classification:'Employer required'};
  if(['Employee requested short shift','Personal early departure'].includes(classification.classification))continue;
  const hours=classification.classification==='Verified variance'?classification.minimumHours:classification.classification==='Verified two-hour category'?2:3;
  const used=new Map<string,number>();for(const [index,span]of intervals.entries()){
   const day=localDate(new Date(Date.parse(span.end)-1).toISOString(),sheet.time_zone),value=totals(span.start,span.end,bs);
   let actual=0;for(const segment of dailySegments(span.start,span.end,bs,sheet.time_zone)){const source=work.daily.find(d=>d.sheet.id===sheet.id&&d.day===segment.day),before=used.get(segment.day)??0,regular=Math.min(segment.paid,Math.max(0,(source?.regular??segment.paid)-before)),rate=rateOn(rates,segment.day);actual+=source?.holiday?wages(rate,segment.paid,policy,'1.5'):wages(rate,regular,policy)+wages(rate,segment.paid-regular,policy,policy.overtimeMultiplier);used.set(segment.day,before+segment.paid);}if(day<p.starts_on||day>p.ends_on||value.paid>=hours*3600)continue;const floor=minimumHourly*hours,topup=Math.max(0,floor-actual);if(topup)lines.push({kind:'Minimum reporting pay',label:'Reporting-pay supplement',amount:topup,date:day,sourceId:sheet.id+':reporting:'+index,taxable:true,pensionable:true,insurable:true,nonPeriodic:false,vacationable:true,detail:JSON.stringify({attendanceId:sheet.attendance_id,actualPaidSeconds:value.paid,actualWages:actual,minimum:floor,classification:classification.classification,decisionId:approved?.id??null,source:'https://www.alberta.ca/hours-work-rest'})});
  }
 }
 return lines;
}
export function bankOvertimeLines(lines:PayLine[],facts:NonNullable<Awaited<ReturnType<typeof operationsPayrollFacts>>>,p:PayPeriod,rates:PayRate[],policy:PayPolicy){
 for(const line of lines.filter(l=>l.kind==='Overtime'&&l.date&&l.seconds)){
  const arrangement=activeArrangement(facts.requests,'Overtime banking',line.date!);if(!arrangement)continue;const c=JSON.parse(arrangement.configuration),earned=line.seconds!,banked=earned*c.bankMultiplier,due=new Date(p.ends_on+'T12:00:00Z');const originalDay=due.getUTCDate();due.setUTCDate(1);due.setUTCMonth(due.getUTCMonth()+c.expiryMonths);const last=new Date(Date.UTC(due.getUTCFullYear(),due.getUTCMonth()+1,0)).getUTCDate();due.setUTCDate(Math.min(originalDay,last));
  line.detail=JSON.stringify({arrangementId:arrangement.id,overtimeSeconds:earned,bankedSeconds:banked,settlementMinor:line.amount,dueOn:due.toISOString().slice(0,10),hourlyMinor:hourlyMinor(rateOn(rates,line.date!),policy).toFixed(8)});line.kind='Overtime banked';line.label='Overtime banked under written agreement';line.amount=0;line.seconds=banked;
 }
}
export function bankPayoutLines(facts:NonNullable<Awaited<ReturnType<typeof operationsPayrollFacts>>>,employee:PayrollEmployee,p:PayPeriod,rates:PayRate[],policy:PayPolicy,days:DayWork[]=[]){
 const available=bankAvailable(facts.entries),lines:PayLine[]=[];if(available.some(c=>c.currency!==policy.currency))return fail(409,'Banked overtime is held in a different payroll currency. Review a separate settlement in the earned currency; no exchange rate is assumed.');
 for(const request of facts.requests.filter(r=>r.kind==='Overtime leave'&&r.effective_on>=p.starts_on&&r.effective_on<=p.ends_on&&!facts.requests.some(w=>w.kind==='Withdraw arrangement'&&JSON.parse(w.configuration).requestId===r.id&&w.effective_on<=r.effective_on))){
  const c=JSON.parse(request.configuration),sameDay=sum(days.filter(d=>d.sheet.status==='Approved'&&d.day===request.effective_on).map(d=>d.paid)),sameWeek=sum(days.filter(d=>d.sheet.status==='Approved'&&week(d.day,policy.workweekStart)===week(request.effective_on,policy.workweekStart)).map(d=>d.paid)),reserved=facts.requests.filter(r=>r.kind==='Overtime leave'&&r.id!==request.id&&week(r.effective_on,policy.workweekStart)===week(request.effective_on,policy.workweekStart));if(sameDay+c.seconds+sum(reserved.filter(r=>r.effective_on===request.effective_on).map(r=>JSON.parse(r.configuration).seconds))>8*3600||sameWeek+c.seconds+sum(reserved.map(r=>JSON.parse(r.configuration).seconds))>44*3600)return fail(409,'Banked time off plus actual work exceeds the Alberta ordinary day/week limit. Review the leave date or settle the remaining bank as overtime.');let left=c.seconds;const allocations:{creditId:string;seconds:number}[]=[];
  for(const credit of available.filter(c=>c.effective_on<=request.effective_on&&c.due_on!>=request.effective_on)){const seconds=Math.min(left,credit.remaining);credit.remaining-=seconds;left-=seconds;if(seconds)allocations.push({creditId:credit.id,seconds});if(!left)break;}
  if(left)return fail(409,'Approved overtime leave exceeds the available unexpired bank balance. Review the reservation and any later payroll correction.');
  lines.push({kind:'Banked overtime leave',label:'Time off using banked overtime',amount:wages(rateOn(rates,request.effective_on),c.seconds,policy),seconds:c.seconds,date:request.effective_on,sourceId:request.id,taxable:true,pensionable:true,insurable:true,nonPeriodic:false,vacationable:true,detail:JSON.stringify({allocations,requestId:request.id})});
 }
 for(const credit of available.filter(c=>c.remaining>0&&(c.due_on!<=p.ends_on||employee.employment_end&&employee.employment_end<=p.ends_on))){
  const settlement=new D(credit.amount_minor).mul(credit.remaining).div(credit.seconds).toDecimalPlaces(0).toNumber();lines.push({kind:'Banked overtime settlement',label:'Unused banked overtime paid out',amount:settlement,date:employee.employment_end&&employee.employment_end<=p.ends_on?employee.employment_end:p.ends_on,sourceId:credit.id,taxable:true,pensionable:true,insurable:true,nonPeriodic:false,vacationable:false,detail:JSON.stringify({allocations:[{creditId:credit.id,seconds:credit.remaining}],originalSource:credit.source_id})});credit.remaining=0;
 }
 return lines;
}
export async function finalizeOperationsPayroll(db:Db,actor:Actor,calc:PayCalculation){if(!controlsEnabled())return;for(const [index,line]of calc.lines.entries()){
 if(line.kind==='Overtime banked'){const c=JSON.parse(line.detail!);await ledger(db,actor,calc.employee.id,'Overtime credit',calc.period.id+':'+index,line.date!,c.bankedSeconds,c,c.dueOn,c.settlementMinor,calc.currency);}
 if(line.kind==='Banked overtime leave'||line.kind==='Banked overtime settlement'){const c=JSON.parse(line.detail!);await ledger(db,actor,calc.employee.id,line.kind==='Banked overtime leave'?'Overtime leave':'Overtime settlement',calc.period.id+':'+index,line.date!,-sum(c.allocations.map((a:{seconds:number})=>a.seconds)),c,null,line.amount,calc.currency);}
 }}
