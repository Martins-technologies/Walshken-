import type {OvertimeSettings} from './employment-settings';
import type {EmploymentRules} from './holiday-types';
import {all,fail,type Actor,type Db} from './server';
import {dailySegments,dayAdd,type WorkBreak} from './attendance-rules';
import {D} from './payroll-money';
import {payrollDataset,type PayrollEmployee} from './payroll-access';
import type {PayPeriod,PayPolicy,PayRate} from './payroll-types';
export type WorkSource={id:string;attendance_id:string;employee_id:string;work_date:string;revision:number;starts_at:string;ends_at:string;time_zone:string;compliance_issues:string;review_note:string;status:string;attendance_revision:number};
export type DayWork={sheet:WorkSource;day:string;paid:number;unpaid:number;paidBreak:number;regular:number;ot:number;holiday:boolean};
export const sum=(values:number[])=>values.reduce((a,b)=>a+b,0);
export const week=(day:string,start:number)=>dayAdd(day,-((new Date(day+'T12:00Z').getUTCDay()-start+7)%7));
export async function workSources(db:Db,actor:Actor,employee:PayrollEmployee,p:PayPeriod){
 if(!employee.hire_date||!/^\d{4}-\d{2}-\d{2}$/.test(employee.hire_date))return fail(409,'Verify the actual employee hire date in the employment profile before payroll calculation.');
 const end=dayAdd(p.ends_on,8)+'T00:00:00Z',start=dayAdd(p.starts_on,-370)+'T00:00:00Z';
 const sheets=await all<WorkSource>(db,`SELECT t.id,t.attendance_id,t.employee_id,t.work_date,t.revision,t.status,t.compliance_issues,t.review_note,a.starts_at,a.ends_at,a.time_zone,a.revision AS attendance_revision FROM timesheets t JOIN attendance a ON a.id=t.attendance_id WHERE t.org_id=? AND t.employee_id=? AND t.release_stage=? AND t.workflow_version=1 AND a.ends_at IS NOT NULL AND a.starts_at<? AND a.ends_at>? ORDER BY a.starts_at,t.id`,actor.org_id,employee.id,payrollDataset(),end,start);
 const breaks=await all<WorkBreak & {attendance_id:string}>(db,`SELECT b.* FROM breaks b JOIN attendance a ON a.id=b.attendance_id WHERE a.org_id=? AND a.employee_id=? AND a.release_stage=? AND a.starts_at<? AND a.ends_at>? AND b.voided_at IS NULL ORDER BY b.starts_at,b.id`,actor.org_id,employee.id,payrollDataset(),end,start);
 const daily:DayWork[]=[];for(const sheet of sheets){for(const segment of dailySegments(sheet.starts_at,sheet.ends_at,breaks.filter(b=>b.attendance_id===sheet.attendance_id),sheet.time_zone)){daily.push({sheet,day:segment.day,paid:segment.paid,unpaid:segment.unpaid,paidBreak:segment.breakSeconds-segment.unpaid,regular:segment.paid,ot:0,holiday:false});}}
 return {sheets,breaks,daily};
}
export function eligibleDate(e:PayrollEmployee,day:string){return day>=e.hire_date&&(!e.contract_start||day>=e.contract_start)&&(!e.employment_end||day<=e.employment_end);}
export function hourlyMinor(rate:PayRate,policy:PayPolicy){if(['CAD','INR','PKR'].includes(rate.currency)&&rate.minor_unit!==2)return fail(409,'This historical pay rate uses a different currency precision. Record a reviewed replacement rate before using it in a new native payroll calculation.');return rate.rate_unit==='Hour'?new D(rate.amount_cents):rate.rate_unit==='Year'?new D(rate.amount_cents).div(52*policy.regularWeekHours):fail(409,'A fixed contract-period rate cannot be used as an hourly employee rate.');}
export function wages(rate:PayRate,seconds:number,policy:PayPolicy,multiplier='1'){return hourlyMinor(rate,policy).mul(seconds).div(3600).mul(multiplier).toDecimalPlaces(0).toNumber();}
export function assignOvertime(days:DayWork[],policy:PayPolicy){
 const grouped=new Map<string,DayWork[]>();for(const row of days.filter(r=>r.sheet.status==='Approved')){const values=grouped.get(row.day)??[];values.push(row);grouped.set(row.day,values);}
 const weeks=new Map<string,{worked:number;dailyOt:number;entitled:number}>();for(const [day,rows] of [...grouped.entries()].sort(([a],[b])=>a.localeCompare(b))){const eligible=rows.filter(r=>!r.holiday),paid=sum(eligible.map(r=>r.paid));if(policy.overtime==='Verified exemption'){continue;}const key=week(day,policy.workweekStart),previous=weeks.get(key)??{worked:0,dailyOt:0,entitled:0},daily=policy.dailyHours?Math.max(0,paid-policy.dailyHours*3600):0,next={worked:previous.worked+paid,dailyOt:previous.dailyOt+daily,entitled:0};next.entitled=Math.max(next.dailyOt,policy.weeklyHours?Math.max(0,next.worked-policy.weeklyHours*3600):0);let overtime=next.entitled-previous.entitled;for(const r of [...eligible].reverse()){r.ot=Math.min(r.paid,overtime);r.regular=r.paid-r.ot;overtime-=r.ot;}weeks.set(key,next);}
}

// Employee values are explicit only on newly configured override profiles. Shared
// company versions then take priority over reference defaults; unmarked history
// retains the former minimum-benefit merge.
export function applyPayrollOvertime(policy:PayPolicy,overtime?:OvertimeSettings&{companyConfigured?:true},legacy?:EmploymentRules){
 if(policy.companyConfigured&&policy.policyValueSource!=='Jurisdiction policy')return;
 if(overtime?.companyConfigured){
  policy.dailyHours=overtime.dailyHours;policy.weeklyHours=overtime.weeklyHours;policy.overtimeMultiplier=overtime.multiplier;policy.workweekStart=overtime.weekStart;
 }else if(legacy?.companyConfigured){
  policy.dailyHours=legacy.dailyOvertimeHours;policy.weeklyHours=legacy.weeklyOvertimeHours;policy.overtimeMultiplier=legacy.overtimeMultiplier;
 }else if(overtime&&policy.policyValueSource==='Jurisdiction policy'){
  policy.dailyHours=overtime.dailyHours;policy.weeklyHours=overtime.weeklyHours;policy.overtimeMultiplier=overtime.multiplier;policy.workweekStart=overtime.weekStart;
 }else if(overtime){
  policy.dailyHours=policy.dailyHours?Math.min(policy.dailyHours,overtime.dailyHours):overtime.dailyHours;
  policy.weeklyHours=policy.weeklyHours?Math.min(policy.weeklyHours,overtime.weeklyHours):overtime.weeklyHours;
  policy.overtimeMultiplier=D.max(new D(policy.overtimeMultiplier),new D(overtime.multiplier)).toString();policy.workweekStart=overtime.weekStart;
 }
}
