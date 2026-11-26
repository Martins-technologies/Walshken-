"use client";
import {ProjectsWorkspace,type ProjectsData} from "./projects";
import {StaffPrivacy,type PrivacyData} from "./staff-privacy";
import {StaffCalendar} from "./staff-calendar";
import type {StaffCalendarData} from "@/lib/walshken/staff-calendar-types";
import {HolidayWorkspace} from "./holidays";
import {PayrollWorkspace} from "./payroll";
import { Calls } from "./calls";
import type { RecordingCategory, RecordingPolicy } from "@/lib/walshken/meeting-recording-policy";
import { Messages } from "./messages";
import { DocumentWorkspace } from "./documents";
import {WorkforceWorkspace} from "./workforce";
import { TaskWorkspace } from "./tasks";
import { StaffSecurity } from "./staff-security";

import { useCallback, useEffect, useState } from "react";
import { countryName, roleNames, taskStatuses, type Role } from "@/lib/walshken/catalog";
import { Icon } from "./brand";
import type { SiteCatalog } from "@/lib/walshken/public-catalog";
import type { Viewer } from "./workspace";
import { ActionForm, api, dateText, Disclosure, Empty, hours, initials, money, options, Panel, Quick, Status, Table, value, type Field, type RecordRow } from "./ui";

export type ViewData = {
  managedProjects?:boolean;
  unreadUpdates?:number; managedWorktime?:boolean;
  management?:{people?:RecordRow|null;attendance?:RecordRow|null;work?:RecordRow|null;security?:RecordRow|null}|null;
  notificationEmail?:{enabled:boolean;revision:number;providerConfigured:boolean;deliveries:RecordRow[]}|null;
  privacy?:boolean;events?:RecordRow[];categories?:readonly string[];actorId?:string;canManage?:boolean;canExport?:boolean;canDispose?:boolean;
  retention?:import("./retention-management").RetentionData|null;
  scanRequired?:boolean;
  scans?:RecordRow[];
  employment?:import("./employment-management").EmploymentManagementData|null;
  readiness?:boolean;
  meetingInviteEmail?:boolean;
  personnelControls?:boolean;
  privacyNotice?:RecordRow|null;
  acknowledgements?:RecordRow[];
  jurisdictionPolicies?:RecordRow[];
  auditFilters?:import("./staff-governance").AuditFilters;
  calculatorId?:string;
  managedCalendar?: boolean; calendar?: StaffCalendarData;
  managedHolidays?:boolean;managedPayroll?:boolean;managedWorkforce?:boolean;managedTasks?:boolean;taskSummary?:{today:number;overdue:number;pending:number;open:number};
  performanceOnly?:boolean;
  managementTeams?:boolean; unitMemberships?:RecordRow[];
  managedDocuments?:boolean;documentStorageEnabled?:boolean;documentBucket?:string;
  collaborationOverview?:boolean; conversations?:RecordRow[];
  rows?:RecordRow[]; row?:RecordRow; staff?:RecordRow[]; projects?:RecordRow[]; shifts?:RecordRow[]; tasks?:RecordRow[];
  alerts?:RecordRow[]; corrections?:RecordRow[]; meetings?:RecordRow[]; leave?:RecordRow[]; holidays?:RecordRow[];
  sessions?:RecordRow[]; units?:RecordRow[]; rates?:RecordRow[]; availability?:RecordRow[]; inquiries?:RecordRow[];
  registry?: { query: string; page: number; pages: number; total: number };
  guestInvites?:{canInvite:boolean;canConfigure:boolean;admission:"Host approval"|"Invitation only";emailConfigured:boolean};
  pendingAttendees?:RecordRow[]; guestMeetings?:boolean; recordingStorage?:boolean; meetingPolicy?:RecordRow;
  recordingCategories?:RecordingCategory[]; recordingSettings?:RecordingPolicy;
  messageDocumentsEnabled?:boolean;
  groups?:string[]; departments?:RecordRow[]; canForwardMessages?:boolean; messageChanges?:string;
  memberManagement?:string; pendingGroups?:RecordRow[]; removedGroups?:RecordRow[]; communicationPolicy?:RecordRow;
  enrollmentOnly?:boolean; mfaRequired?:boolean; compensation?:RecordRow|null;
  active?:RecordRow|null; drafts?:number; provider?:boolean; secureStorage?:boolean; encryptionMigrationReady?:boolean; catalog?:SiteCatalog;
};
export const manages=(actor:Viewer)=>["super_admin","admin","manager","hr"].includes(actor.role);
export const employeeField=(staff:RecordRow[],name="employee",label="Employee"):Field=>({name,label,options:options(staff),required:true});
const field=(name:string,label:string,type="text",required=true):Field=>({name,label,type,required});
const column=(key:string,title:string)=>({key,title});
const statusColumn={key:"status",title:"Status",render:(row:RecordRow)=><Status>{row.status}</Status>};
export const dateColumn=(key:string,title:string,withTime=false,zone?:string)=>({key,title,render:(row:RecordRow)=>dateText(row[key],withTime,zone)});
const durationColumn=(key:string,title:string)=>({key,title,render:(row:RecordRow)=>hours(row[key])});

function Overview({actor,allowed,data,refresh}:{actor:Viewer;allowed:readonly string[];data:ViewData;refresh:()=>void}){
  const can=(key:string)=>allowed.includes(key);
  const alerts=data.alerts??[];
  const meetings=[...(data.meetings??[])].sort((one,two)=>value(one,"starts_at").localeCompare(value(two,"starts_at")));
  const tasks=(data.tasks??[]).filter(task=>!["Completed","Cancelled"].includes(value(task,"status")));
  const unread=data.unreadUpdates??alerts.filter(row=>!row.read_at).length;
  const stats:{key:string;icon:string;label:string;count:number}[]=data.collaborationOverview?[
    {key:"tasks",icon:"check",label:"Open tasks",count:data.taskSummary?.open??0},
    {key:"calls",icon:"video",label:"Upcoming meetings",count:meetings.length},
    {key:"messages",icon:"message",label:"Conversations",count:(data.conversations??[]).filter(row=>!row.archived).length},
    {key:"notifications",icon:"bell",label:"Unread updates",count:unread},
  ]:[
    {key:"tasks",icon:"check",label:"Open tasks",count:tasks.length},
    {key:"shifts",icon:"shift",label:"Upcoming shifts",count:data.shifts?.length??0},
    {key:"timesheets",icon:"list",label:"Draft timesheets",count:data.drafts??0},
    {key:"notifications",icon:"bell",label:"Unread updates",count:unread},
  ];
  const management=data.management;
  const managementCards=[
    ["employees","users","Active employees",management?.people?.active],
    ["scheduling","clock","Clocked in now",management?.attendance?.clocked_in],
    ["approvals","list","Timesheets to review",management?.attendance?.submitted_timesheets],
    ["audit","shield","Active sessions",management?.security?.sessions],
  ].filter(([key,,,count])=>typeof count==="number"&&can(String(key)));

  return <div className="workspace-overview">
    {stats.some(item=>can(item.key))&&<section className="overview-metrics" aria-label="Your activity">
      {stats.filter(item=>can(item.key)).map(({key,icon,label,count})=><a className="overview-metric" href={`/staff/${key}`} key={key}>
        <span className="icon-tile"><Icon name={icon} size={19}/></span><Icon name="external" className="overview-metric-arrow" size={16}/>
        <strong>{count.toLocaleString("en-CA")}</strong><span>{label}</span>
      </a>)}
    </section>}
    {can("attendance")&&<section className="overview-worktime" aria-label="Attendance status">
      <span className="icon-tile"><Icon name="clock" size={18}/></span>
      <div><strong>{data.active?data.active.break_started?"On a break":"Clocked in":"Clocked out"}</strong><small>{data.active?.starts_at?`Shift started ${dateText(data.active.starts_at,true,actor.timeZone)}`:"Clock in when your work begins."}</small></div>
      {data.active||data.managedWorktime?<a href="/staff/attendance" className="btn btn-outline btn-small">Open attendance <Icon name="right" size={15}/></a>:<Quick path="attendance/in" refresh={refresh} variant="blue">Clock in</Quick>}
    </section>}
    <div className="overview-panels">
      <div className="overview-primary">
        {data.collaborationOverview&&can("calls")&&<Panel title="Upcoming meetings" action={<a className="text-link" href="/staff/calls">All meetings <Icon name="right" size={15}/></a>}>
          {meetings.length?<ul className="overview-events">{meetings.slice(0,5).map(row=><li key={value(row,"id")}><a href={`/staff/calls?meeting=${encodeURIComponent(value(row,"id"))}`}>
            <span className="icon-tile"><Icon name={row.mode==="Audio"?"phone":"video"} size={17}/></span>
            <span><strong>{row.title}</strong><small>{dateText(row.starts_at,true,actor.timeZone)}</small></span>
            <Icon name="next" size={15}/>
          </a></li>)}</ul>:<Empty title="No upcoming meetings" body="Scheduled meetings and active calls will appear here." icon="calendar"/>}
        </Panel>}
        {can("tasks")&&<Panel title={data.collaborationOverview?"Your tasks":"Upcoming tasks"} action={<a className="text-link" href="/staff/tasks">All tasks <Icon name="right" size={15}/></a>}>
          {tasks.length?<Table rows={tasks.slice(0,5)} columns={[column("title","Task"),dateColumn("due_date","Due"),statusColumn]}/>:<Empty title="No open tasks" body="New assignments will appear here." icon="check"/>}
          {!!data.taskSummary&&(data.taskSummary.overdue>0||data.taskSummary.today>0)&&<p className="overview-task-note">
            {data.taskSummary.today>0&&<span>{data.taskSummary.today} due or starting today</span>}
            {data.taskSummary.overdue>0&&<span className="overview-overdue">{data.taskSummary.overdue} overdue</span>}
          </p>}
        </Panel>}
      </div>
      {can("notifications")&&<Panel title="Recent updates" action={<a className="text-link" href="/staff/notifications">All updates <Icon name="right" size={15}/></a>}>
        {alerts.length?<ul className="overview-activity">{alerts.slice(0,6).map(row=><li key={value(row,"id")}><a href={value(row,"href")||"/staff/notifications"}>
          <span className="icon-tile"><Icon name="bell" size={16}/></span>
          <span><strong>{row.title}{!row.read_at&&<span className="overview-unread"><span className="sr-only">Unread</span></span>}</strong><small>{row.body}</small><small>{dateText(row.created_at,true,actor.timeZone)}</small></span>
        </a></li>)}</ul>:<Empty title="You’re all caught up" body="New assignments, invitations and decisions will appear here." icon="bell"/>}
      </Panel>}
    </div>
    {managementCards.length>0&&<Panel title="Organization snapshot" note="Current records across your organization.">
      <div className="overview-management">{managementCards.map(([key,icon,label,count])=><a key={key} href={`/staff/${key}`}><Icon name={String(icon)} size={18}/><span>{label}</span><strong>{count}</strong><Icon name="next" size={15}/></a>)}</div>
    </Panel>}
  </div>;
}

function Tasks({actor,data,refresh}:{actor:Viewer;data:ViewData;refresh:()=>void}){
  const [selected,setSelected]=useState(""),[comments,setComments]=useState<RecordRow[]>([]),[error,setError]=useState("");
  const rows=data.rows??[];
  const task=rows.find((row)=>row.id===selected);
  const loadComments=useCallback(()=>{
    if(!selected)return;
    api(`task-comments/${selected}`).then((result)=>{setComments(result.rows);setError("");},(e)=>setError(e.message));
  },[selected]);
  useEffect(()=>{loadComments();},[loadComments]);
  return <>
    <Panel title="Task list" note={manages(actor)?"Assignments in your scope":"Your assigned work"}>
      {manages(actor)&&<Disclosure title="Assign a task"><ActionForm path="tasks/add" fields={[
        field("title","Task title"),employeeField(data.staff??[],"employee","Assignee"),{name:"project",label:"Project",options:options(data.projects??[])},
        {name:"priority",label:"Priority",options:["Low","Normal","High","Urgent"],value:"Normal",required:true},
        field("startDate","Start date","date",false),field("dueDate","Due date","date",false),field("estimate","Estimated minutes","number",false),field("description","Description","textarea",false),
      ]} submit="Assign task" refresh={refresh}/></Disclosure>}
      <Table rows={rows} columns={[column("title","Task"),column("name","Assignee"),column("priority","Priority"),dateColumn("due_date","Due"),statusColumn]}
        actions={(row)=><button type="button" className="btn btn-outline btn-small" onClick={()=>{setSelected(value(row,"id"));setComments([]);setError("");}}>Open</button>}/>
    </Panel>
    {task&&<Panel title={value(task,"title")} note={value(task,"description")||"Task details"}>
      <ActionForm key={selected} path="tasks/status" fields={[
        {name:"status",label:"Progress",options:manages(actor)?taskStatuses:taskStatuses.filter((s)=>s!=="Completed"&&s!=="Cancelled"),value:task.status,required:true},
        {name:"actual",label:"Actual minutes",type:"number",value:task.actual_minutes,min:0,max:100000},
      ]} extra={{id:selected}} submit="Update progress" refresh={refresh} reset={false}/>
      <h3 className="subheading">Discussion</h3>
      {error&&<p className="form-error">{error}</p>}
      <Table rows={comments} columns={[column("name","Author"),column("body","Comment"),dateColumn("created_at","Posted",true,actor.timeZone)]} empty="No comments yet"/>
      <ActionForm path="tasks/comment" fields={[field("body","Add a comment","textarea")]} extra={{id:selected}} submit="Post comment" refresh={loadComments}/>
    </Panel>}
  </>;
}

function TimeViews({section,actor,data,refresh}:{section:string;actor:Viewer;data:ViewData;refresh:()=>void}){
  const rows=data.rows??[], corrections=data.corrections??[],zone=actor.timeZone;
  if(section==="attendance"){
    const active=rows.find((row)=>!row.ends_at);
    return <>
      <Panel title="Time clock" note="Attendance is tracked separately from sign-in.">
        <div className="clock-panel"><span className="icon-tile"><Icon name={active?.break_started?"coffee":"clock"} size={28}/></span>
          <div><strong>{active?active.break_started?"On break":"Clocked in":"Clocked out"}</strong><small>{active?dateText(active.break_started||active.starts_at,true,zone):"Start when you begin working."}</small></div>
          <div className="clock-actions">{!active?<Quick path="attendance/in" refresh={refresh} variant="blue">Clock in</Quick>
            :active.break_started?<Quick path="attendance/end-break" refresh={refresh} variant="blue">End break</Quick>
              :<><Quick path="attendance/start-break" refresh={refresh}>Start break</Quick><Quick path="attendance/out" refresh={refresh} variant="blue">Clock out</Quick></>}</div>
        </div>
      </Panel>
      <Panel title="Attendance history"><Table rows={rows} columns={[dateColumn("starts_at","Clock in",true,zone),dateColumn("ends_at","Clock out",true,zone),column("time_zone","Recorded time zone")]}/></Panel>
      <Panel title="Correction requests"><Disclosure title="Request a correction"><ActionForm path="attendance/correction" fields={[
        {name:"attendanceId",label:"Attendance entry",options:rows.map((row)=>[value(row,"id"),dateText(row.starts_at,true,zone)] as const)},field("note","What needs correcting?","textarea"),
      ]} submit="Submit correction" refresh={refresh}/></Disclosure><Table rows={corrections} columns={[column("note","Request"),dateColumn("created_at","Requested"),statusColumn]}/></Panel>
    </>;
  }
  if(section==="shifts"||section==="scheduling") return <Panel title={section==="scheduling"?"Published schedules":"My published shifts"}>
    {section==="scheduling"&&<Disclosure title="Publish a shift"><ActionForm path="shifts/add" fields={[
      employeeField(data.staff??[]),field("title","Shift title"),field("location","Location"),field("startsAt","Start in your device time zone","datetime-local"),field("endsAt","End in your device time zone","datetime-local"),
    ]} submit="Publish shift" refresh={refresh}/></Disclosure>}
    <Table rows={rows} columns={[column("title","Shift"),column("name","Employee"),dateColumn("starts_at","Starts",true,zone),dateColumn("ends_at","Ends",true,zone),column("location","Location")]} empty="No shifts published"/>
  </Panel>;
  if(section==="leave") return <Panel title="Leave requests">
    <Disclosure title="Request leave"><ActionForm path="leave/request" fields={[
      {name:"category",label:"Leave type",options:["Vacation","Sick leave","Personal leave","Other"],required:true},field("startsOn","First day","date"),
      field("endsOn","Last day","date"),field("note","Note","textarea",false),
    ]} submit="Request leave" refresh={refresh}/></Disclosure>
    <Table rows={rows} columns={[column("name","Employee"),column("category","Type"),dateColumn("starts_on","From"),dateColumn("ends_on","Through"),statusColumn]}
      actions={manages(actor)?(row)=>row.status==="Pending"&&row.employee_id!==actor.id&&<><Quick path="leave/review" data={{id:row.id,status:"Approved"}} refresh={refresh}>Approve</Quick><Quick path="leave/review" data={{id:row.id,status:"Declined"}} refresh={refresh}>Decline</Quick></>:undefined}/>
  </Panel>;
  const review=section==="approvals";
  return <>
    <Panel title={review?"Timesheet queue":"My timesheets"} note="Payable time excludes unpaid breaks.">
      {review&&<Disclosure title="Add manual entry"><ActionForm path="timesheets/manual" fields={[
        employeeField((data.staff??[]).filter((row)=>row.id!==actor.id)),field("workDate","Work date","date"),field("grossMinutes","Gross minutes","number"),
        field("unpaidMinutes","Unpaid break minutes","number",false),field("note","Reason","textarea"),
      ]} submit="Add for review" refresh={refresh}/></Disclosure>}
      <Table rows={rows} columns={[column("name","Employee"),dateColumn("work_date","Work date"),durationColumn("gross_seconds","Gross"),
        durationColumn("unpaid_seconds","Unpaid break"),durationColumn("paid_seconds","Payable"),statusColumn]} actions={(row)=>review?
          row.status==="Submitted"&&<><Quick path="timesheets/review" data={{id:row.id,status:"Approved"}} refresh={refresh}>Approve</Quick>
            <Quick path="timesheets/review" data={{id:row.id,status:"Returned"}} refresh={refresh}>Return</Quick></>
        :["Draft","Returned"].includes(value(row,"status"))&&<Quick path="timesheets/submit" data={{id:row.id}} refresh={refresh}>Submit</Quick>}/>
    </Panel>
    {review&&<Panel title="Attendance corrections" note="Record your review decision, then enter adjusted hours as a separate manual timesheet when applicable.">
      <Table rows={corrections} columns={[column("name","Employee"),column("note","Request"),statusColumn]} actions={(row)=>row.status==="Pending"&&
        <><Quick path="corrections/review" data={{id:row.id,status:"Reviewed"}} refresh={refresh}>Mark reviewed</Quick>
        <Quick path="corrections/review" data={{id:row.id,status:"Returned"}} refresh={refresh}>Return</Quick></>}/>
    </Panel>}
  </>;
}
export { TimeViews };

function Calendar({data,actor}:{data:ViewData;actor:Viewer}){
  const [view,setView]=useState("Month"),[focus,setFocus]=useState(()=>new Date());
  const [eventType,setEventType]=useState("All events");
  const local=(input:string)=>new Intl.DateTimeFormat("en-CA",{year:"numeric",month:"2-digit",day:"2-digit",timeZone:actor.timeZone}).format(new Date(input));
  const getDay=(day:Date)=>`${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,"0")}-${String(day.getDate()).padStart(2,"0")}`;
  const events=[
    ...(data.shifts??[]).map((r)=>({id:r.id,date:local(value(r,"starts_at")),title:r.title,type:"Shift"})),
    ...(data.tasks??[]).filter((r)=>r.due_date).map((r)=>({id:r.id,date:value(r,"due_date"),title:r.title,type:"Task"})),
    ...(data.meetings??[]).map((r)=>({id:r.id,date:local(value(r,"starts_at")),title:r.title,type:"Meeting"})),
    ...(data.holidays??[]).map((r)=>({id:r.id,date:value(r,"on_date"),title:r.name,type:"Holiday"})),
    ...(data.leave??[]).map((r)=>({id:r.id,date:value(r,"starts_on"),end:value(r,"ends_on"),title:r.category,type:"Leave"})),
  ];
  const first=new Date(focus.getFullYear(),focus.getMonth(),view==="Month"?1:focus.getDate());
  if(view!=="Day") first.setDate(first.getDate()-first.getDay());
  const days=Array.from({length:view==="Month"?42:view==="Week"?7:1},(_,index)=>new Date(first.getFullYear(),first.getMonth(),first.getDate()+index));
  function move(n:number){
    setFocus((current)=>view==="Month"?new Date(current.getFullYear(),current.getMonth()+n,1):new Date(current.getFullYear(),current.getMonth(),current.getDate()+n*(view==="Week"?7:1)));
  }
  return <Panel title="Work calendar" action={<div className="calendar-controls"><button type="button" className="icon-button" aria-label="Previous" onClick={()=>move(-1)}><Icon name="previous" size={17}/></button>
    <button type="button" className="icon-button" aria-label="Next" onClick={()=>move(1)}><Icon name="next" size={17}/></button></div>}>
    <div className="calendar-filter"><strong>{new Intl.DateTimeFormat("en-CA",{month:"long",year:"numeric",...(view==="Day"?{day:"numeric"}:{})}).format(focus)}</strong>
      <label className="sr-only" htmlFor="cal-mode">Calendar view</label><select id="cal-mode" value={view} onChange={(e)=>setView(e.target.value)}>{["Month","Week","Day"].map((label)=><option key={label}>{label}</option>)}</select>
      <label className="sr-only" htmlFor="event-type">Event type</label><select id="event-type" value={eventType} onChange={(e)=>setEventType(e.target.value)}>{["All events","Shift","Task","Meeting","Holiday","Leave"].map((label)=><option key={label}>{label}</option>)}</select></div>
    <div className="calendar-scroll"><div className={view==="Day"?"calendar-grid calendar-day":"calendar-grid"}>
      {view!=="Day"&&["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((day)=><span className="calendar-weekday" key={day}>{day}</span>)}
      {days.map((day)=>{const dayKey=getDay(day);return <div className={day.getMonth()===focus.getMonth()?"calendar-cell":"calendar-cell outside"} key={dayKey}>
        <strong>{day.getDate()}</strong>
        {events.filter((event)=>(event.date===dayKey||("end" in event&&String(event.date)<=dayKey&&String(event.end)>=dayKey))&&(eventType==="All events"||eventType===event.type)).map((event)=>
          <span className="calendar-event" title={`${event.type}: ${event.title}`} key={`${event.type}-${event.id}`}>{event.title}</span>)}
      </div>;})}
    </div></div>
  </Panel>;
}

export function DocumentView({actor,data,refresh,admin=false}:{actor:Viewer;data:ViewData;refresh:()=>void;admin?:boolean}){
  if(data.managedDocuments)return <DocumentWorkspace actor={actor} initial={data} admin={admin}/>;
  return <LegacyDocumentView actor={actor} data={data} refresh={refresh} admin={admin}/>;
}
function LegacyDocumentView({actor,data,refresh,admin=false}:{actor:Viewer;data:ViewData;refresh:()=>void;admin?:boolean}){
  const [share,setShare]=useState("");
  return <Panel title={admin?"Private document registry":"Your documents"} note="Files are available only to authorized staff.">
    {!admin&&actor.role!=="guest"&&<Disclosure title="Upload a document"><ActionForm path="documents/upload" fields={[field("file","PDF, Office document or image, up to 3 MB","file")]} submit="Upload privately" refresh={refresh} file/></Disclosure>}
    <Table rows={data.rows??[]} columns={[column("name","Document"),column("owner","Owner"),
      {key:"bytes",title:"Size",render:(row)=>`${Math.max(1,Math.round(Number(row.bytes)/1024))} KB`},dateColumn("created_at","Uploaded"),
      {key:"revoked_at",title:"Access",render:(row)=><Status>{row.revoked_at?"Revoked":row.downloadable?"Download permitted":"Details only"}</Status>}]}
      actions={(row)=>!row.revoked_at&&<>
        {Boolean(row.downloadable)&&<><a className="btn btn-outline btn-small" target="_blank" rel="noreferrer" href={`/api/workspace/files/${row.id}?mode=preview`}>Open</a>
          <a className="btn btn-outline btn-small" href={`/api/workspace/files/${row.id}`}>Download</a></>}
        {(admin||row.owner_id===actor.id)&&<><button className="btn btn-outline btn-small" type="button" onClick={()=>setShare(value(row,"id"))}>Permissions</button>
          <Quick path="documents/revoke" data={{id:row.id}} refresh={refresh} variant="danger">Revoke</Quick></>}
      </>}/>
    {share&&<div className="nested-panel"><h3>Internal document access</h3>
      <ActionForm path="documents/share" fields={[employeeField(data.staff??[]),{name:"download",label:"Permission",options:[["0","Details only"],["1","Open and download"]],required:true}]}
        extra={{id:share}} submit="Grant access" refresh={refresh}/>
      <ActionForm path="documents/unshare" fields={[employeeField(data.staff??[])]} extra={{id:share}} submit="Remove access" refresh={refresh}/>
    </div>}
  </Panel>;
}

export function WorkspaceViews({section,actor,allowed,data,refresh,setQuery}:{section:string;actor:Viewer;allowed:readonly string[];data:ViewData;refresh:()=>void;setQuery:(q:string)=>void}){
  const rows=data.rows??[];
  if(data.managedHolidays)return <HolidayWorkspace actor={actor} data={data} refresh={refresh} setQuery={setQuery}/>;
  if(data.managedPayroll)return <PayrollWorkspace actor={actor} data={data} refresh={refresh} setQuery={setQuery}/>;
  if(data.managedWorkforce)return <WorkforceWorkspace section={section} actor={actor} initial={data}/>;
  if(section==="privacy")return <StaffPrivacy data={data as PrivacyData} refresh={refresh}/>;
  if(section==="dashboard")return <Overview actor={actor} allowed={allowed} data={data} refresh={refresh}/>;
  if(section==="tasks")return data.managedTasks?<TaskWorkspace actor={actor} initial={data}/>:<Tasks actor={actor} data={data} refresh={refresh}/>;
  if(["attendance","shifts","timesheets","leave"].includes(section))return <TimeViews section={section} actor={actor} data={data} refresh={refresh}/>;
  if(section==="calendar"&&data.managedCalendar&&data.calendar)return <StaffCalendar data={data.calendar} refresh={refresh} setQuery={setQuery}/>;
  if(section==="calendar")return <Calendar actor={actor} data={data}/>;
  if(section==="messages")return <Messages actor={actor} data={data} refresh={refresh}/>;
  if(section==="documents")return <DocumentView actor={actor} data={data} refresh={refresh}/>;
  if(section==="projects"&&data.managedProjects)return <ProjectsWorkspace data={data as unknown as ProjectsData} refresh={refresh} setQuery={setQuery}/>;
  if(section==="projects")return <Panel title="Projects">{manages(actor)&&<Disclosure title="Create project"><ActionForm path="projects/add" fields={[field("name","Project name"),field("description","Description","textarea",false)]} submit="Create project" refresh={refresh}/></Disclosure>}
    <Table rows={rows} columns={[column("name","Project"),column("description","Description"),column("tasks","Tasks"),statusColumn]} empty="No projects assigned"/></Panel>;
  if(section==="calls")return <Calls actor={actor} data={data} refresh={refresh}/>;
  if(section==="directory")return <Panel title="People in your workspace">
    {rows.length?<div className="people-grid">{rows.map((row)=><div className="person-card" key={value(row,"id")}><span className="avatar">{initials(value(row,"name"))}</span><div><strong>{row.name}</strong><small>{row.title||row.department||"Walshken staff"}</small></div></div>)}</div>:<Empty icon="users" title="No teammates in your scope"/>}
  </Panel>;
  if(section==="notifications")return <>{data.notificationEmail&&<Panel title="Email notifications" note="Email is off by default. Enable it to receive a generic sign-in link for new updates at your work email. Sensitive details remain inside the workspace.">
    <ActionForm key={data.notificationEmail.revision} path="notifications/preferences" fields={[{name:"enabled",label:"Email me about new workspace updates",type:"checkbox",value:data.notificationEmail.enabled?1:0}]} extra={{revision:data.notificationEmail.revision}} submit="Save email preference" refresh={refresh} reset={false}/>
    {!data.notificationEmail.providerConfigured&&<p className="form-note">Email delivery is awaiting the administrator’s verified sender configuration. Your in-app notifications remain available.</p>}
    {data.notificationEmail.deliveries.length>0&&<Disclosure title="Recent email activity"><Table rows={data.notificationEmail.deliveries} columns={[dateColumn("created_at","Created"),statusColumn,column("attempts","Attempts")]} empty="No email activity"/><p className="form-note">Sent means accepted by the email provider. It does not confirm inbox delivery. Failed updates remain available in your in-app notifications.</p></Disclosure>}
  </Panel>}<Panel title="Recent notifications" action={rows.some((row)=>!row.read_at)&&<Quick path="notifications/read" refresh={refresh}>Mark all as read</Quick>}>
    {rows.length?<div className="notification-list">{rows.map((row)=><a href={value(row,"href")} key={value(row,"id")}><span className="icon-tile"><Icon name="bell" size={16}/></span>
      <div><strong>{row.title}</strong><small>{row.body} · {dateText(row.created_at,true,actor.timeZone)}</small></div>{!row.read_at&&<Status>New</Status>}</a>)}</div>:<Empty icon="bell" title="You’re all caught up"/>}
  </Panel></>;
  if(section==="salary")return <Panel title="Approved payroll records" note="Your approved payroll records are private to your account and authorized payroll staff.">
    <Table rows={rows} columns={[dateColumn("starts_on","Period start"),dateColumn("ends_on","Period end"),durationColumn("payable_seconds","Payable hours"),
      {key:"gross_cents",title:"Gross",render:(row)=>money(row.gross_cents,value(row,"currency"))},statusColumn]} empty="No approved records"/>
  </Panel>;
  if(section==="profile"){
    if(data.enrollmentOnly) return <StaffSecurity enabled={false} required/>;
    const row=data.row??{};
    const tenure=row.hire_date?Math.max(0,Math.floor((Date.now()-Date.parse(String(row.hire_date)))/86400_000)):null;
    const photo = value(row,"photo_version");
    const attributes=[
      ["Work email",row.email],["Contact number",row.phone],["Employee ID",row.employee_no],["Role",roleNames[value(row,"role") as Role]],["Position",row.title],["Department",row.department],
      ["Division",row.division],["Office",row.office],["Country",row.country==="ZZ"?null:countryName(value(row,"country"))],["Employment jurisdiction",row.jurisdiction],
      ["Manager",row.manager],["Employment type",row.employment_type],["Hire date",dateText(row.hire_date)],["Length of service",tenure===null?null:`${tenure} days`],
      ["Contract start",dateText(row.contract_start)],["Employment end",dateText(row.employment_end)],["Employment status",row.employment_status],["Account access",row.status],
      ["Account created",dateText(row.created_at)],["Account activated",dateText(row.activated_at)],["First sign-in",dateText(row.first_login_at,true,actor.timeZone)],
      ["Last sign-in",dateText(row.last_login_at,true,actor.timeZone)],["Work time zone",row.time_zone],["Expected weekly hours",row.expected_hours],["Break policy",row.break_policy],["Annual leave days",row.leave_days],["Assigned schedule",row.work_schedule],["Holiday calendar",row.holiday_calendar],["Annual holiday entitlement (days)",row.holiday_days],
    ];
    return <><Panel title="Employment details" note="Ask your administrator to update your legal name, work email, or employment records."><div className="profile-summary">{photo
      ? <img className="avatar avatar-large" style={{objectFit:"cover"}} src={`/api/workspace/profile/photo?v=${encodeURIComponent(photo)}`} alt="Your profile photo"/>
      : <span className="avatar avatar-large">{initials(actor.name)}</span>}<div><h3>{actor.name}</h3><p>{row.title||roleNames[actor.role]}</p></div></div>
      <dl className="profile-grid">{attributes.map(([name,item])=><div key={name}><dt>{name}</dt><dd>{item??"—"}</dd></div>)}</dl></Panel>
      <Panel title="Contact details">
        <ActionForm path="profile/contact" fields={[{name:"phone",label:"Phone number",type:"tel",value:row.phone,max:40,autoComplete:"tel"}]}
          submit="Save contact details" refresh={refresh} reset={false}/>
      </Panel>
      <Panel title="Profile photo" note="Upload a PNG, JPEG, or WebP under 1 MB.">
        <ActionForm path="profile/photo" file fields={[{ name:"photo",label:"Choose a photo",type:"file",accept:"image/png,image/jpeg,image/webp",required:true }]} submit="Upload photo" refresh={refresh}/>
        {photo&&<Quick path="profile/remove-photo" refresh={refresh}>Remove photo</Quick>}
      </Panel>
      {actor.role!=="guest"&&<Panel title="My compensation">
        {data.compensation?<dl className="profile-grid">
          <div><dt>Compensation type</dt><dd>{data.compensation.kind}</dd></div>
          <div><dt>Current rate</dt><dd>{money(data.compensation.amount_cents,value(data.compensation,"currency"))}</dd></div>
          <div><dt>Payroll currency</dt><dd>{data.compensation.currency}</dd></div>
          <div><dt>Effective from</dt><dd>{dateText(data.compensation.effective_on)}</dd></div>
        </dl>:<p className="form-note">No current compensation rate is recorded.</p>}
      </Panel>}
      <StaffSecurity enabled={Boolean(row.mfa_enabled)} required={Boolean(data.mfaRequired)}/>
      {data.privacyNotice&&<Panel title={String(data.privacyNotice.title)} note={`Published ${String(data.privacyNotice.created_at).slice(0,10)}`}>
        <p style={{whiteSpace:"pre-wrap"}}>{data.privacyNotice.body}</p>
        {data.privacyNotice.acknowledged_at?<p>Acknowledged on {String(data.privacyNotice.acknowledged_at).slice(0,10)}.</p>
          :<Quick path="governance/notice-acknowledge" data={{id:data.privacyNotice.id}} refresh={refresh}>Acknowledge notice</Quick>}
      </Panel>}
      <Panel title="Change password" note="Saving a new password signs you out on every device.">
        <ActionForm path="session/password" fields={[
          {name:"currentPassword",label:"Current password",type:"password",required:true,max:160,autoComplete:"current-password"},
          {name:"newPassword",label:"New password",type:"password",required:true,min:12,max:160},
          {name:"confirmPassword",label:"Confirm new password",type:"password",required:true,min:12,max:160},
        ]} submit="Update password" onDone={() => window.location.assign("/staff")}/>
      </Panel>
      <Panel title="Recent sessions" action={<Quick path="session/close-others" refresh={refresh}>Sign out other devices</Quick>}><Table rows={data.sessions??[]} columns={[dateColumn("created_at","Started",true,actor.timeZone),dateColumn("ended_at","Ended",true,actor.timeZone),dateColumn("expires_at","Expires",true,actor.timeZone),column("agent","Device information")]}/></Panel></>;
  }
  return <Empty/>;
}
