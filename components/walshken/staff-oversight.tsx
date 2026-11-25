"use client";
import { Panel, Table, dateText, hours, type RecordRow } from "./ui";

export type ManagementData = {
  day: string;
  people: RecordRow | null;
  attendance: RecordRow | null;
  work: RecordRow | null;
  security: RecordRow | null;
  payroll: RecordRow[];
  nextPay: RecordRow[];
  joiners: RecordRow[];
  anniversaries: RecordRow[];
  securityEvents: RecordRow[];
  files: RecordRow[];
  workExceptions?: RecordRow[] | null;
};

type Metric = [string, string, string];
function Metrics({data, items}: {data:RecordRow | null;items:Metric[]}) {
  return <div className="stats-grid">{items.map(([key,label,href])=>
    <a className="stat-card" key={key} href={href}><strong>{data?.[key] ?? "—"}</strong><span>{label}</span></a>)}</div>;
}
const personnel: Metric[] = [
  ["employees","Employees","/staff/employees"],["active","Active","/staff/employees"],
  ["inactive","Inactive","/staff/employees"],["on_leave","On leave","/staff/employees"],
  ["missing_jurisdiction","Jurisdiction missing","/staff/employees"],
];
const attendance: Metric[] = [
  ["clocked_in","Clocked in","/staff/reports"],["on_break","On break","/staff/reports"],["absences","Absences recorded today","/staff/reports"],
  ["corrections","Pending corrections","/staff/approvals"],["missing_timesheets","Draft or returned timesheets","/staff/approvals"],
  ["submitted_timesheets","Timesheets to approve","/staff/approvals"],["leave_requests","Leave requests to review","/staff/leave"],
];
const operations: Metric[] = [
  ["open_tasks","Open tasks","/staff/tasks"],["completed_tasks","Completed tasks","/staff/tasks"],
  ["overdue_tasks","Overdue tasks","/staff/tasks"],["tasks_to_review","Tasks to review","/staff/tasks"],["active_projects","Active projects","/staff/projects"],
];
const security: Metric[] = [
  ["sessions","Active sessions","/staff/audit"],["sign_ins","Sign-ins today","/staff/audit"],["failed","Failed sign-ins today","/staff/audit"],
  ["permission_changes","Permission changes this month","/staff/audit"],["alerts","Sign-in alerts this month","/staff/audit"],
];
const activity = [{key:"created_at",title:"Time",render:(row:RecordRow)=>dateText(row.created_at,true)},{key:"name",title:"Employee"},{key:"action",title:"Action"}];

export function StaffOversight({data}: {data:ManagementData}) {
  return <>
    <Panel title="People" note="Current employee records">
      <Metrics data={data.people} items={personnel}/>
      <div className="panel-grid">
        <div><h3>Latest hire dates</h3><Table rows={data.joiners} columns={[{key:"name",title:"Employee"},{key:"hire_date",title:"Hire date"}]} empty="No hire dates recorded"/></div>
        <div><h3>Next work anniversaries</h3><Table rows={data.anniversaries} columns={[{key:"name",title:"Employee"},{key:"hire_date",title:"Hire anniversary",render:row=>String(row.hire_date).slice(5)}]} empty="No upcoming anniversaries"/></div>
      </div>
    </Panel>
    <Panel title="Attendance and approvals"><Metrics data={data.attendance} items={attendance}/>
      {data.workExceptions && <WorkExceptions rows={data.workExceptions} from={data.day.slice(0,7)+"-01"} through={data.day}/>}
    </Panel>
    <Panel title="Operations"><Metrics data={data.work} items={operations}/></Panel>
    <Panel title="Payroll" note="Draft gross estimates by currency. Final records are in Payroll management." action={<a href="/staff/payroll" className="text-link">Payroll history</a>}>
      <Table rows={data.payroll} columns={[
        {key:"currency",title:"Currency"},{key:"regular",title:"Regular",render:row=>hours(Number(row.regular))},
        {key:"overtime",title:"Overtime",render:row=>hours(Number(row.overtime))},
        {key:"gross",title:"Estimated gross",render:row=>new Intl.NumberFormat("en",{style:"currency",currency:String(row.currency)}).format(Number(row.gross)/10**Number(row.minor_unit))},
      ]} empty="No draft payroll estimates"/>
      <h3>Upcoming pay dates</h3>
      <Table rows={data.nextPay} columns={[{key:"label",title:"Period"},{key:"pay_date",title:"Pay date"},{key:"status",title:"Status"}]} empty="No upcoming pay dates"/>
    </Panel>
    <Panel title="Security activity" action={<a href="/staff/audit" className="text-link">Search audit history</a>}>
      <Metrics data={data.security} items={security}/>
      <div className="panel-grid">
        <div><h3>Recent access changes</h3><Table rows={data.securityEvents} columns={activity} empty="No recent sign-ins or permission changes"/></div>
        <div><h3>Recent document activity</h3><Table rows={data.files} columns={activity} empty="No document events"/></div>
      </div>
    </Panel>
  </>;
}


export function WorkExceptions({ rows, from, through, drillDown = true }: {rows:RecordRow[];from:string;through:string;drillDown?:boolean}) {
  const totals = ["Missing timesheet","Attendance follow-up"].map(issue => [issue, rows.find(row=>row.issue===issue)?.issue_count ?? 0]);
  const reviewUrl="/staff/approvals?"+new URLSearchParams({from,to:through,team:"1",exceptions:"1"});
  return <section className="work-exceptions">
    <h3>Expected time records</h3>
    <p>Closed attendance without a timesheet is separate from a past shift with no attendance to verify.</p>
    <p>{dateText(from)} – {dateText(through)} · {totals.map(([label,count])=>`${label}: ${count}`).join(" · ")}</p>
    <Table rows={rows.slice(0,drillDown?6:150)} columns={[
      {key:"name",title:"Employee"}, {key:"work_date",title:"Work date",render:row=>dateText(row.work_date)},
      {key:"issue",title:"Needs follow-up"},
      {key:"shift_id",title:"Schedule",render:row=>row.shift_id?"Published shift":"Unscheduled work"},
    ]} empty="No expected time records are missing in this period"/>
    {drillDown && <a className="text-link" href={reviewUrl}>Review expected time records</a>}
  </section>;
}
