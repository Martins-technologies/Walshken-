import { expectedTimesheets, expectedTimesheetsEnabled } from "./expected-timesheets";
import {actionScope,hasAction} from './staff-authority';
import {employeeLeaveBalances} from "./leave-balances";
import {staffReadinessEnabled,type StaffAction} from './staff-permissions';
import {all,AppError,audit,canManage,canSuper,date,fail,json,now,one,scope,str,type Actor,type Db} from './server';
import {albertaRules,compliance,dailySegments,dayAdd,defaultPolicy,localInstant,localWall,totals,type WorkBreak,type WorkPolicy} from './attendance-rules';
import {localDate} from './work';
import {attendanceFor,entryBreaks,policyAdmin,requireWorkforce,workDataset,workforcePolicy,type Attendance,type Shift} from './workforce';
import {holidaysEnabled,holidayScope} from './holiday-access';
import {employmentEngineEnabled} from './employment-catalog';
import {applicableHolidays} from './holiday-engine';
export function workRange(actor:Actor,params:URLSearchParams){const today=localDate(now(),actor.time_zone),from=date(params.get('from')??today.slice(0,7)+'-01','report start')!,to=date(params.get('to')??new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(5,7)),0)).toISOString().slice(0,10),'report end')!;if(to<from||Date.parse(to)-Date.parse(from)>93*86400000)return fail(400,'Choose a report range up to 94 days.');return {from,to};}
function workforceTeamAccess(actor:Actor) {
 if(canManage(actor))return true;
 const actions:StaffAction[]=['attendance.read','attendance.approve','attendance.policy','attendance.corrections','shifts.read','shifts.manage','timesheets.read','leave.read','leave.approve'];
 return staffReadinessEnabled() && (actor.permissions??[]).some(rule=>rule.effect==='allow'
   && actions.includes(rule.action) && (rule.scope_type!=='employee'||rule.scope_id!==actor.id) && hasAction(actor,rule.action));
}
function workforceReadScope(actor:Actor,action:StaffAction,team:boolean) {
 const personal={sql:'e.id=?',args:[actor.id]};
 if(!staffReadinessEnabled())return team?scope(actor,'e'):personal;
 const permitted=actionScope(actor,action,'e',true);
 return team?permitted:{sql:`(${permitted.sql}) AND ${personal.sql}`,args:[...permitted.args,...personal.args]};
}
export async function workforceReport(db:Db,actor:Actor,params:URLSearchParams,exportReport=false){
 requireWorkforce(actor);
 const {from,to}=workRange(actor,params),team=params.get('team')==='1'&&workforceTeamAccess(actor),period=['day','week','month'].includes(params.get('period')??'')?params.get('period')!:'day';
 const read=workforceReadScope(actor,'attendance.read',team);
 const exportScope=exportReport&&staffReadinessEnabled()?actionScope(actor,'attendance.export','e',true):{sql:'1=1',args:[]};
 const scoped={sql:`(${read.sql}) AND (${exportScope.sql})`,args:[...read.args,...exportScope.args]};
 type AttendanceRow=Pick<Attendance,'id'|'employee_id'|'starts_at'|'ends_at'|'time_zone'> & {name:string;employee_no:string;status:string|null;breaks:WorkBreak[]};
 const records=await all<AttendanceRow>(db,`SELECT a.id,a.employee_id,a.starts_at,a.ends_at,a.time_zone,e.name,e.employee_no,t.status,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('starts_at',b.starts_at,'ends_at',b.ends_at,'paid',b.paid))
    FROM breaks b WHERE b.attendance_id=a.id AND b.voided_at IS NULL),'[]'::jsonb) AS breaks
  FROM attendance a JOIN employees e ON e.id=a.employee_id LEFT JOIN timesheets t ON t.attendance_id=a.id
  WHERE a.org_id=? AND a.release_stage=? AND a.workflow_version=1
    AND a.starts_at<? AND (a.ends_at IS NULL OR a.ends_at>?) AND ${scoped.sql}
  ORDER BY a.starts_at LIMIT 10001`,actor.org_id,workDataset(),dayAdd(to,2)+'T00:00:00Z',dayAdd(from,-1)+'T00:00:00Z',...scoped.args);
 if(records.length>10000)return fail(400,'This report has too many work intervals. Narrow the date range.');
 const groups=new Map<string,{employee:string;employeeNo:string;employeeId:string;period:string;gross:number;unpaid:number;paid:number;approved:number;openRecords:number;entries:number}>();
 const bounds=new Map<string,{first:string;last:string}>(), recordedAt=now();
 for(const row of records){
  let limits=bounds.get(row.time_zone);
  if(!limits){
   limits={first:localInstant(from+'T00:00',row.time_zone),last:localInstant(dayAdd(to,1)+'T00:00',row.time_zone)};
   bounds.set(row.time_zone,limits);
  }
  const start=row.starts_at>limits.first?row.starts_at:limits.first;
  const recordEnd=row.ends_at??recordedAt,end=recordEnd<limits.last?recordEnd:limits.last;
  if(end<=start)continue;
  for(const day of dailySegments(start,end,row.breaks,row.time_zone)){
   if(day.day<from||day.day>to)continue;
   const bucket=period==='month'?day.day.slice(0,7):period==='week'?dayAdd(day.day,-((new Date(day.day+'T12:00Z').getUTCDay()+6)%7)):day.day;
   const key=row.employee_id+':'+bucket;
   const group=groups.get(key)??{employee:row.name,employeeNo:row.employee_no,employeeId:row.employee_id,period:bucket,gross:0,unpaid:0,paid:0,approved:0,openRecords:0,entries:0};
   group.gross+=day.gross;group.unpaid+=day.unpaid;group.paid+=day.paid;
   if(row.status==='Approved')group.approved+=day.paid;
   if(!row.ends_at)group.openRecords++;
   group.entries++;
   groups.set(key,group);
  }
 }
 return {from,to,period,rows:[...groups.values()].sort((a,b)=>a.period.localeCompare(b.period)||a.employee.localeCompare(b.employee)),totals:[...groups.values()].reduce((s,r)=>({gross:s.gross+r.gross,unpaid:s.unpaid+r.unpaid,paid:s.paid+r.paid,approved:s.approved+r.approved}),{gross:0,unpaid:0,paid:0,approved:0})};
}
const workforceSections=new Set(['attendance','reports','shifts','scheduling','timesheets','approvals','leave','holidays']);
export async function workforceData(db:Db,actor:Actor,params=new URLSearchParams()){
 requireWorkforce(actor);const {from,to}=workRange(actor,params),manager=workforceTeamAccess(actor),team=params.get('team')==='1'&&manager,scoped=workforceReadScope(actor,'attendance.read',team),start=dayAdd(from,-1)+'T00:00:00Z',end=dayAdd(to,2)+'T00:00:00Z';
 const requested=params.get('section')??'', section=workforceSections.has(requested)?requested:'';
 const needs=(...sections:string[])=>!section||sections.includes(section);
 const detailPolicy=!section||params.get('details')==='policy';
 const attendance=needs('attendance','reports'), clock=needs('attendance');
 const schedule=needs('shifts','scheduling'), timeOff=needs('leave','holidays'), sheetsView=needs('attendance','timesheets','approvals');
 const calendars=schedule||timeOff, notices=attendance||schedule||timeOff;
 const resourceScope=(action:StaffAction)=>workforceReadScope(actor,action,team);
 const shiftScope=resourceScope('shifts.read'),sheetScope=resourceScope('timesheets.read'),leaveScope=resourceScope('leave.read'),policyScope=staffReadinessEnabled()?actionScope(actor,'attendance.policy','e',true):scope(actor,'e');
 const [records,allBreaks,shifts,sheets,corrections,leave,holidays,absences,staff,swaps,events,policies,versions]=await Promise.all([
  attendance?all<Attendance & {name:string;shift_start:string|null;shift_end:string|null;title:string|null;location:string|null;timesheet_status:string|null}>(db,`SELECT a.*,e.name,s.starts_at AS shift_start,s.ends_at AS shift_end,s.title,s.location,t.status AS timesheet_status FROM attendance a JOIN employees e ON e.id=a.employee_id LEFT JOIN shifts s ON s.id=a.shift_id LEFT JOIN timesheets t ON t.attendance_id=a.id WHERE a.org_id=? AND a.release_stage=? AND a.workflow_version=1 AND a.starts_at<? AND (a.ends_at IS NULL OR a.ends_at>?) AND ${scoped.sql} ORDER BY a.starts_at DESC LIMIT 501`,actor.org_id,workDataset(),end,start,...scoped.args):Promise.resolve([]),
  attendance?all<WorkBreak & {attendance_id:string;label:string}>(db,`SELECT b.* FROM breaks b JOIN attendance a ON a.id=b.attendance_id JOIN employees e ON e.id=a.employee_id WHERE a.org_id=? AND a.release_stage=? AND a.starts_at<? AND (a.ends_at IS NULL OR a.ends_at>?) AND b.voided_at IS NULL AND ${scoped.sql} ORDER BY b.starts_at`,actor.org_id,workDataset(),end,start,...scoped.args):Promise.resolve([]),
  schedule?all<Shift & {name:string;leave_conflict:number;holiday_conflict:number}>(db,`SELECT s.*,e.name,(SELECT count(*)::int FROM leave_requests l WHERE l.employee_id=e.id AND l.release_stage=? AND l.status='Approved' AND l.starts_on<=to_char(s.ends_at::timestamptz AT TIME ZONE (CASE WHEN s.time_zone IN('America/Edmonton','Canada/Mountain') AND s.starts_at>='2026-11-01' THEN 'Etc/GMT+6' ELSE s.time_zone END),'YYYY-MM-DD') AND l.ends_on>=to_char(s.starts_at::timestamptz AT TIME ZONE (CASE WHEN s.time_zone IN('America/Edmonton','Canada/Mountain') AND s.starts_at>='2026-11-01' THEN 'Etc/GMT+6' ELSE s.time_zone END),'YYYY-MM-DD')) AS leave_conflict,(SELECT count(*)::int FROM holidays h WHERE h.org_id=s.org_id AND h.release_stage=? AND h.cancelled_at IS NULL AND h.jurisdiction=e.jurisdiction AND h.on_date=to_char(s.starts_at::timestamptz AT TIME ZONE (CASE WHEN s.time_zone IN('America/Edmonton','Canada/Mountain') AND s.starts_at>='2026-11-01' THEN 'Etc/GMT+6' ELSE s.time_zone END),'YYYY-MM-DD')) AS holiday_conflict FROM shifts s JOIN employees e ON e.id=s.employee_id WHERE s.org_id=? AND s.release_stage=? AND s.workflow_version=1 AND s.starts_at<? AND s.ends_at>? AND ${shiftScope.sql} AND (?=1 OR s.state<>'Draft') ORDER BY s.starts_at LIMIT 1001`,workDataset(),workDataset(),actor.org_id,workDataset(),end,start,...shiftScope.args,team?1:0):Promise.resolve([]),
  all(db,`SELECT t.*,e.name,a.starts_at,a.ends_at,a.source FROM timesheets t JOIN employees e ON e.id=t.employee_id LEFT JOIN attendance a ON a.id=t.attendance_id WHERE t.org_id=? AND t.release_stage=? AND t.workflow_version=1 AND t.work_date BETWEEN ? AND ? AND ${sheetScope.sql} ORDER BY t.work_date DESC,t.created_at DESC LIMIT 501`,actor.org_id,workDataset(),from,to,...sheetScope.args),
  sheetsView?all(db,`SELECT c.*,e.name FROM corrections c JOIN employees e ON e.id=c.employee_id WHERE e.org_id=? AND c.release_stage=? AND ${scoped.sql} ORDER BY CASE WHEN c.status='Pending' THEN 0 ELSE 1 END,c.created_at DESC LIMIT 100`,actor.org_id,workDataset(),...scoped.args):Promise.resolve([]),
  notices?all(db,`SELECT l.*,e.name FROM leave_requests l JOIN employees e ON e.id=l.employee_id WHERE l.org_id=? AND l.release_stage=? AND l.starts_on<=? AND l.ends_on>=? AND ${leaveScope.sql} ORDER BY l.starts_on DESC LIMIT 501`,actor.org_id,workDataset(),to,from,...leaveScope.args):Promise.resolve([]),
  calendars?all(db,'SELECT * FROM holidays WHERE org_id=? AND release_stage=? AND on_date BETWEEN ? AND ? ORDER BY on_date',actor.org_id,workDataset(),from,to):Promise.resolve([]),
  notices?all(db,`SELECT x.*,e.name,s.starts_at,s.ends_at,s.title,s.time_zone FROM attendance_absences x JOIN employees e ON e.id=x.employee_id JOIN shifts s ON s.id=x.shift_id WHERE x.org_id=? AND x.release_stage=? AND s.starts_at<? AND s.ends_at>? AND ${scoped.sql} ORDER BY s.starts_at DESC LIMIT 501`,actor.org_id,workDataset(),end,start,...scoped.args):Promise.resolve([]),
  manager?all(db,`SELECT e.id,e.org_id,e.name,e.role,e.department_id,e.division_id,e.jurisdiction,e.time_zone,e.break_policy FROM employees e WHERE e.org_id=? AND e.role<>'guest' AND e.status='Active' AND e.employment_status<>'Ended' AND ${scope(actor,'e').sql} ORDER BY e.name`,actor.org_id,...scope(actor,'e').args):Promise.resolve([]),
  schedule?all(db,`SELECT x.*,a.starts_at AS source_start,a.ends_at AS source_end,a.title AS source_title,b.starts_at AS target_start,b.ends_at AS target_end,b.title AS target_title,e.name AS requester,p.name AS partner FROM shift_swaps x JOIN shifts a ON a.id=x.source_shift JOIN shifts b ON b.id=x.target_shift JOIN employees e ON e.id=x.requester_id JOIN employees p ON p.id=x.partner_id WHERE x.org_id=? AND x.release_stage=? AND (x.requester_id=? OR x.partner_id=? OR (?=1 AND ${scope(actor,'e',false).sql} AND ${scope(actor,'p',false).sql})) ORDER BY x.created_at DESC LIMIT 100`,actor.org_id,workDataset(),actor.id,actor.id,team?1:0,...scope(actor,'e',false).args,...scope(actor,'p',false).args):Promise.resolve([]),
  all(db,`SELECT w.id,w.employee_id,w.action,w.entity,w.target_id,w.created_at,e.name,a.name AS actor,w.detail FROM work_events w JOIN employees e ON e.id=w.employee_id LEFT JOIN employees a ON a.id=w.actor_id WHERE w.org_id=? AND w.release_stage=? AND ${scoped.sql} ORDER BY w.created_at DESC LIMIT 100`,actor.org_id,workDataset(),...scoped.args),
  manager&&detailPolicy?all<{employee_id:string;settings:string;revision:number}>(db,`SELECT p.employee_id,p.settings,p.revision FROM work_policies p JOIN employees e ON e.id=p.employee_id WHERE p.org_id=? AND p.release_stage=? AND ${policyScope.sql}`,actor.org_id,workDataset(),...policyScope.args):Promise.resolve([]),
  manager&&detailPolicy&&staffReadinessEnabled()?all<{employee_id:string;settings:string;revision:number;effective_on:string;time_zone:string}>(db,`SELECT p.employee_id,p.settings,p.revision,p.effective_on,e.time_zone
   FROM staff_work_policy_versions p JOIN employees e ON e.id=p.employee_id
   WHERE p.org_id=? AND p.release_stage=? AND ${policyScope.sql}
   ORDER BY p.effective_on DESC,p.revision DESC`,actor.org_id,workDataset(),...policyScope.args):Promise.resolve([])
 ]);
 const myActive=clock?await one<Attendance>(db,'SELECT * FROM attendance WHERE employee_id=? AND release_stage=? AND workflow_version=1 AND ends_at IS NULL',actor.id,workDataset()):null,myBreaks=myActive?await entryBreaks(db,myActive.id):[],today=localDate(now(),actor.time_zone);
 let actorPolicy:WorkPolicy|null=null,policyRevision=0,policyError='';
 if(clock||attendance||sheetsView||detailPolicy)try{const p=await workforcePolicy(db,actor);actorPolicy=p.policy;policyRevision=p.revision;}catch(e){policyError=(e as Error).message;}
 const currentShifts=clock?await all<Shift>(db,"SELECT * FROM shifts WHERE employee_id=? AND release_stage=? AND workflow_version=1 AND state='Published' AND starts_at<? AND ends_at>? ORDER BY starts_at",actor.id,workDataset(),new Date(Date.now()+7200000).toISOString(),now()):[];
 const swapChoices=schedule?await all<Shift & {name:string}>(db,"SELECT s.*,e.name FROM shifts s JOIN employees e ON e.id=s.employee_id WHERE s.org_id=? AND s.release_stage=? AND s.state='Published' AND s.starts_at>? AND s.starts_at<? AND e.id<>? AND e.status='Active' AND e.employment_status<>'Ended' AND ((e.department_id IS NOT NULL AND e.department_id=?) OR(e.division_id IS NOT NULL AND e.division_id=?)) ORDER BY s.starts_at LIMIT 200",actor.org_id,workDataset(),new Date(Date.now()+86400000).toISOString(),dayAdd(today,94)+'T00:00:00Z',actor.id,actor.department_id,actor.division_id):[];
 const rows=records.slice(0,500).filter(a=>!a.ends_at||localDate(a.starts_at,a.time_zone)<=to&&localDate(a.ends_at,a.time_zone)>=from).map(a=>{const breaks=allBreaks.filter(b=>b.attendance_id===a.id),p=JSON.parse(a.policy_snapshot) as WorkPolicy;return {...a,breaks,totals:totals(a.starts_at,a.ends_at??now(),breaks),issues:a.ends_at?compliance(a.starts_at,a.ends_at,breaks,p):[],lateMinutes:a.shift_start?Math.max(0,Math.round((Date.parse(a.starts_at)-Date.parse(a.shift_start))/60000)):0,earlyMinutes:a.shift_end&&a.ends_at?Math.max(0,Math.round((Date.parse(a.shift_end)-Date.parse(a.ends_at))/60000)):0,late:a.shift_start?Date.parse(a.starts_at)>Date.parse(a.shift_start)+(p.lateGrace??0)*60000:false,early:a.shift_end&&a.ends_at?Date.parse(a.ends_at)<Date.parse(a.shift_end)-(p.earlyGrace??0)*60000:false,missedClockOut:!a.ends_at&&Date.parse(a.starts_at)<Date.now()-16*3600000};});
 const holidaySetupIssues:{employee:string;reason:string}[]=[];
 let effectiveHolidays=holidays;if(calendars&&holidaysEnabled()){
 const holidayRead=await holidayScope(db,actor), dynamic=employmentEngineEnabled();
 // Resolve both source permissions and the effective jurisdiction once for the whole calendar.
 const jurisdiction=dynamic?`COALESCE((SELECT terms.jurisdiction FROM staff_employment_terms terms
  WHERE terms.org_id=e.org_id AND terms.employee_id=e.id AND terms.effective_on<=to_char(effective.at AT TIME ZONE
    (CASE WHEN e.time_zone IN ('America/Edmonton','Canada/Mountain') AND effective.at>=TIMESTAMPTZ '2026-11-01T00:00:00Z'
      THEN 'Etc/GMT+6' ELSE e.time_zone END),'YYYY-MM-DD')
  ORDER BY terms.effective_on DESC LIMIT 1), e.jurisdiction)`:'e.jurisdiction';
 const employees=await all<Actor>(db,`SELECT e.id,e.org_id,e.time_zone,${jurisdiction} AS jurisdiction FROM employees e
  ${dynamic?'CROSS JOIN (SELECT ?::timestamptz AS at) effective':''}
  WHERE e.org_id=? AND e.role<>'guest' AND (${scoped.sql}) AND (${holidayRead.sql}) ORDER BY e.id`,
  ...(dynamic?[now()]:[]),actor.org_id,...scoped.args,...holidayRead.args);
 const generated=new Map<string,typeof holidays[number]>();
 for(const person of employees){
  try{
   for(const h of await applicableHolidays(db,person,from,to)){
    const key=person.jurisdiction+':'+h.day+':'+h.key;
    generated.set(key,{id:key,name:h.name,on_date:h.day,type:h.required?'Statutory':'Company',jurisdiction:person.jurisdiction,cancelled_at:null});
   }
  }catch(error){
   if(error instanceof AppError&&error.status===409)holidaySetupIssues.push({employee:person.id,reason:error.message});
   else throw error;
  }
 }
 effectiveHolidays=[...generated.values()];for(const s of shifts)s.holiday_conflict=0;
 }
 const policyStaff=await Promise.all(staff.map(async e=>{
  const legacy=policies.find(p=>p.employee_id===e.id),changes=versions.filter(p=>p.employee_id===e.id);
  let policy:WorkPolicy|null=null,policyError='';
  if(detailPolicy)try{policy=e.id===actor.id?actorPolicy:(await workforcePolicy(db,e as unknown as Actor)).policy;}catch(error){policyError=(error as Error).message;}
  return {...e,policy,policyError,policyRevision:Math.max(legacy?.revision??0,...changes.map(p=>p.revision)),policyVersions:changes.map(p=>({effective:p.effective_on,revision:p.revision}))};
 }));
 let leaveBalances=null,leaveError='';if(timeOff)try{leaveBalances=await employeeLeaveBalances(db,actor,today);}catch(error){leaveError=(error as Error).message;}
 const [report,workExceptions]=await Promise.all([workforceReport(db,actor,params),expectedTimesheetsEnabled()&&params.get("exceptions")==="1"?expectedTimesheets(db,actor,from,to,!team):Promise.resolve(null)]);return json({managedWorkforce:true,canViewPerformance:process.env.WALSHKEN_MANAGEMENT_REPORTS_ENABLED==="1"&&hasAction(actor,"performance.read"),canExportAttendance:!staffReadinessEnabled()||hasAction(actor,'attendance.export'),detailPolicy,workExceptions,holidaySetupIssues,leaveBalances,leaveError,staffReadiness:staffReadinessEnabled(),team,manager,policyAdmin:policyAdmin(actor),actorId:actor.id,from,to,today,serverTime:now(),rules:albertaRules,rows,shifts:shifts.slice(0,1000),sheets,corrections,leave,holidays:effectiveHolidays,holidayManagement:holidaysEnabled(),absences,staff:policyStaff,swaps,events,policies:policies.map(p=>({...p,settings:JSON.parse(p.settings)})),policy:actorPolicy,policyRevision,policyError,active:myActive?{...myActive,breaks:myBreaks,policy:JSON.parse(myActive.policy_snapshot)}:null,currentShifts,swapChoices,report,truncated:records.length>500||shifts.length>1000});
}
export async function workforceDetail(db:Db,actor:Actor,target:string){const entry=await attendanceFor(db,actor,target);return json({entry,breaks:await entryBreaks(db,entry.id),events:await all(db,'SELECT w.*,a.name AS actor FROM work_events w LEFT JOIN employees a ON a.id=w.actor_id WHERE w.org_id=? AND w.release_stage=? AND w.employee_id=? AND (w.target_id=? OR w.target_id IN(SELECT id FROM corrections WHERE attendance_id=?) OR w.target_id IN(SELECT id FROM timesheets WHERE attendance_id=?)) ORDER BY w.created_at DESC LIMIT 200',actor.org_id,workDataset(),entry.employee_id,entry.id,entry.id,entry.id)});}
export async function workforceCsv(db:Db,actor:Actor,params:URLSearchParams){if(staffReadinessEnabled()&&!hasAction(actor,'attendance.export'))return fail(403,'Attendance report export is outside your authority.');const report=await workforceReport(db,actor,params,true),quote=(v:unknown)=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"',rows=[['Employee ID','Employee','Period','Gross hours','Unpaid break hours','Payable recorded hours','Approved hours','Open intervals'],...report.rows.map(r=>[r.employeeNo,r.employee,r.period,(r.gross/3600).toFixed(4),(r.unpaid/3600).toFixed(4),(r.paid/3600).toFixed(4),(r.approved/3600).toFixed(4),r.openRecords])];await audit(db,actor,'Attendance report exported','attendance report',report.from+' to '+report.to).run();return new Response('\uFEFF'+rows.map(r=>r.map(quote).join(',')).join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="attendance-${report.from}-${report.to}.csv"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}
