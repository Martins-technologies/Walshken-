"use client";
import { Calls } from "./calls";
import { Messages } from "./messages";
import { StaffSecurity } from "./staff-security";

import { useCallback, useEffect, useState } from "react";
import { countryName, roleNames, taskStatuses, type Role } from "@/lib/walshken/catalog";
import { Icon } from "./brand";
import type { SiteCatalog } from "@/lib/walshken/public-catalog";
import type { Viewer } from "./workspace";
import { ActionForm, api, dateText, Disclosure, Empty, hours, initials, money, options, Panel, Quick, Status, Table, value, type Field, type RecordRow } from "./ui";

export type ViewData = {
  collaborationOverview?:boolean; conversations?:RecordRow[];
  rows?:RecordRow[]; row?:RecordRow; staff?:RecordRow[]; projects?:RecordRow[]; shifts?:RecordRow[]; tasks?:RecordRow[];
  alerts?:RecordRow[]; corrections?:RecordRow[]; meetings?:RecordRow[]; leave?:RecordRow[]; holidays?:RecordRow[];
  sessions?:RecordRow[]; units?:RecordRow[]; rates?:RecordRow[]; availability?:RecordRow[]; inquiries?:RecordRow[];
  registry?: { query: string; page: number; pages: number; total: number };
  pendingAttendees?:RecordRow[]; guestMeetings?:boolean; recordingStorage?:boolean; meetingPolicy?:RecordRow;
  groups?:string[]; departments?:RecordRow[]; canForwardMessages?:boolean; messageChanges?:string;
  memberManagement?:string; pendingGroups?:RecordRow[]; communicationPolicy?:RecordRow;
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

function Overview({actor,data,refresh}:{actor:Viewer;data:ViewData;refresh:()=>void}){
  if(data.collaborationOverview){
    const conversations=data.conversations??[],meetings=data.meetings??[],alerts=data.alerts??[];
    const stats=[["message","Conversations",conversations.length,"/staff/messages"],["video","Upcoming meetings",meetings.length,"/staff/calls"],["bell","Unread updates",alerts.filter(row=>!row.read_at).length,"/staff/notifications"]];
    return <><div className="dashboard-banner"><div><div className="section-kicker"><span/> YOUR TEAM WORKSPACE</div><h2>Connect with your team.</h2><p>Keep conversations, meetings and work profiles in one secure place.</p><a className="btn btn-white btn-small" href="/staff/messages">Open messages <Icon name="right" size={16}/></a></div><div className="dashboard-motif" aria-hidden="true"><Icon name="message" size={98}/></div></div>
      <div className="stats-grid">{stats.map(([icon,label,count,href])=><a className="stat-card" href={String(href)} key={String(label)}><span className="icon-tile"><Icon name={String(icon)} size={19}/></span><strong>{count}</strong><span>{label}</span><Icon name="external" className="stat-arrow" size={16}/></a>)}</div>
      <div className="panel-grid"><Panel title="Upcoming meetings" action={<a className="text-link" href="/staff/calls">Open calls <Icon name="right" size={15}/></a>}><Table rows={meetings.slice(0,5)} columns={[column("title","Meeting"),dateColumn("starts_at","Starts",true,actor.timeZone),column("mode","Mode")]} empty="No upcoming meetings"/></Panel>
      <Panel title="Recent updates" action={<a className="text-link" href="/staff/notifications">View updates <Icon name="right" size={15}/></a>}>{alerts.length?<div className="notification-list">{alerts.slice(0,5).map(row=><a href={value(row,"href")} key={value(row,"id")}><span className="icon-tile"><Icon name="bell" size={16}/></span><div><strong>{row.title}</strong><small>{row.body}</small></div><Icon name="next" size={16}/></a>)}</div>:<Empty title="You’re all caught up" body="Your team invitations and updates will appear here." icon="bell"/>}</Panel></div></>;
  }
  const tasks=(data.tasks??[]).filter((task)=>!["Completed","Cancelled"].includes(value(task,"status")));
  const alerts=(data.alerts??[]).filter((notice)=>!notice.read_at);
  const stats=actor.role==="guest"?[["bell","Unread notifications",alerts.length,"/staff/notifications"]]:
    [["check","Open tasks",tasks.length,"/staff/tasks"],["shift","Upcoming shifts",data.shifts?.length??0,"/staff/shifts"],
      ["list","Draft timesheets",data.drafts??0,"/staff/timesheets"],["bell","Unread notifications",alerts.length,"/staff/notifications"]];
  return <>
    <div className="dashboard-banner"><div><div className="section-kicker"><span/> YOUR WORKDAY</div><h2>{data.active?data.active.break_started?"You’re on a break.":"You’re clocked in.":"Your workday at a glance."}</h2>
      <p>{data.active?"Manage your active shift from attendance.":"Check your tasks, shifts and recent updates."}</p>
      {actor.role!=="guest"&&(data.active?<a href={"/staff/attendance"} className="btn btn-white btn-small">Open attendance <Icon name="right" size={16}/></a>
        :<Quick path="attendance/in" refresh={refresh} variant="white"><Icon name="clock" size={16}/> Clock in</Quick>)}</div><div className="dashboard-motif" aria-hidden="true"><Icon name="layout" size={98}/></div></div>
    <div className="stats-grid">{stats.map(([icon,label,number,href])=><a className="stat-card" href={String(href)} key={label}><span className="icon-tile"><Icon name={String(icon)} size={19}/></span><strong>{number}</strong><span>{label}</span><Icon name="external" className="stat-arrow" size={16}/></a>)}</div>
    <div className="panel-grid">
      {actor.role!=="guest"&&<Panel title="Upcoming tasks" action={<a className="text-link" href={"/staff/tasks"}>View tasks <Icon name="right" size={15}/></a>}>
        <Table rows={tasks.slice(0,5)} columns={[column("title","Task"),dateColumn("due_date","Due"),statusColumn]} empty="No open tasks"/>
      </Panel>}
      <Panel title="Recent updates" action={<a className="text-link" href={"/staff/notifications"}>View notifications <Icon name="right" size={15}/></a>}>
        {(data.alerts??[]).length?<div className="notification-list">{(data.alerts??[]).slice(0,5).map((row)=><a href={value(row,"href")} key={value(row,"id")}><span className="icon-tile"><Icon name="bell" size={16}/></span><div><strong>{row.title}</strong><small>{row.body}</small></div><Icon name="next" size={16}/></a>)}</div>
          :<Empty title="You’re all caught up" body="New assignments and decisions will appear here." icon="bell"/>}
      </Panel>
    </div>
  </>;
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
    </d…3880 tokens truncated…   if (key && !await one(tx, "SELECT id FROM units WHERE id=? AND org_id=? AND kind=?", key, actor.org_id, kind)) {
            fail(400, `Choose a valid ${kind.toLowerCase()}.`);
          }
        }
        if (manager) {
          const supervisor = await scopedEmployee(tx, actor, manager);
          if (supervisor.id === target || !canManage(supervisor) || supervisor.status !== "Active" || supervisor.employment_status === "Ended") fail(400, "Choose an active manager.");
          const cycle = await one(tx, `WITH RECURSIVE chain(id,manager_id) AS (
            SELECT id,manager_id FROM employees WHERE id=? AND org_id=?
            UNION
            SELECT e.id,e.manager_id FROM employees e JOIN chain c ON e.id=c.manager_id WHERE e.org_id=?
          ) SELECT id FROM chain WHERE id=?`, manager, actor.org_id, actor.org_id, target);
          if (cycle) fail(400, "This reporting manager would create a reporting loop.");
        }
        const current = await one<{email:string}>(tx,"SELECT email FROM employees WHERE id=? AND org_id=? FOR UPDATE",target,actor.org_id);
        if (!current) return fail(404,"Employee record is unavailable.");
        await run(tx, `UPDATE employees SET employee_no=?,email=?,name=?,title=?,department_id=?,division_id=?,office_id=?,manager_id=?,
          country=?,jurisdiction=?,time_zone=?,employment_type=?,hire_date=?,contract_start=?,employment_end=?,
          phone=?,expected_hours=?,break_policy=?,leave_days=?,work_schedule=?,holiday_calendar=?,holiday_days=?,employment_status=? WHERE id=? AND org_id=?`,
          employeeNo, workEmail, str(data.name,"employee name",100), str(data.title,"job title",100,false), department || null, division || null,
          office || null, manager || null, country(data.country), str(data.jurisdiction,"jurisdiction",30),
          timeZone(data.timeZone), pick(data.employmentType,types,"employment type"), hire, contract, end,
          str(data.phone,"phone number",40,false) || null, integer(data.expectedHours,"expected weekly hours",0,80),
          pick(data.breakPolicy,["paid","unpaid"],"break policy"), data.leaveDays !== "" && data.leaveDays != null ? integer(data.leaveDays,"leave days",0,365) : null,
          str(data.workSchedule,"work schedule",180,false) || null, str(data.holidayCalendar,"holiday calendar",100,false) || null,
          data.holidayDays !== "" && data.holidayDays != null ? integer(data.holidayDays,"annual holiday entitlement",0,365) : null,
          employmentStatus,target, actor.org_id);
        if (employmentStatus==="Ended" || current.email!==workEmail) {
          const at=now();
          await run(tx,"UPDATE sessions SET ended_at=? WHERE employee_id=? AND ended_at IS NULL",at,target);
          await run(tx,"UPDATE invitations SET consumed_at=? WHERE employee_id=? AND consumed_at IS NULL",at,target);
        }
        await audit(tx, actor, "Employee profile updated", "employee", target).run();
        if (current.email!==workEmail) await audit(tx,actor,"Staff sign-in email updated","identity",target).run();
      });
      return json({ ok: true, message: "Employee profile updated." });
    }
    if (action === "status") {
      const status = pick(data.status, ["Active","Suspended"], "account status");
      if (status==="Active" && employee.employment_status==="Ended") return fail(409,"Update employment status before reactivating access.");
      await db.batch([
        stmt(db, "UPDATE employees SET status=? WHERE id=?", status, target),
        stmt(db, "UPDATE sessions SET ended_at=? WHERE employee_id=? AND ended_at IS NULL AND ?='Suspended'", now(), target, status),
        audit(db, actor, status === "Suspended" ? "Employee suspended" : "Employee reactivated", "employee", target),
      ]);
      return json({ ok: true, message: `Employee ${status.toLowerCase()}.` });
    }
    if (action === "role") {
      requireSuper(actor);
      const role = pick(data.role, roles.filter((item) => item !== "super_admin"), "staff role");
      await db.batch([stmt(db,"UPDATE employees SET role=? WHERE id=?",role,target), audit(db,actor,"Role changed","employee",target)]);
      return json({ ok:true, message:"Staff role updated." });
    }
    if (action === "invite") {
      requireSuper(actor);
      if (employee.status !== "Active" || employee.employment_status==="Ended") return fail(409, "Reactivate this employee first.");
      const code = randomBytes(27).toString("base64url");
      await db.batch([
        stmt(db,"UPDATE invitations SET consumed_at=? WHERE employee_id=? AND consumed_at IS NULL",now(),target),
        stmt(db,"INSERT INTO invitations (id,employee_id,code_hash,expires_at) VALUES (?,?,?,?)",id(),target,await digest(code),new Date(Date.now()+48*3_600_000).toISOString()),
        audit(db,actor,"Access code issued","employee",target),
      ]);
      return json({ ok: true, code, message: "A new access code is ready. It expires in 48 hours." });
    }
  }
  if (area === "organization" && action === "add") {
    requireSuper(actor);
    const target = id();
    const kind = pick(data.kind, ["Department","Division","Office"], "organization unit type");
    await db.batch([
      stmt(db,"INSERT INTO units (id,org_id,kind,name,country,region,time_zone) VALUES (?,?,?,?,?,?,?)",
        target,actor.org_id,kind,str(data.name,"name",100),kind==="Office"?country(data.country):null,
        kind==="Office"?str(data.region,"province or region",80,false):null,kind==="Office"?timeZone(data.timeZone):null),
      audit(db,actor,"Organization unit created","unit",target),
    ]);
    return json({ ok:true, message:`${kind} added.` },201);
  }
  if (area === "communication-policy") {
    if(!communicationAdmin(actor))return fail(403,"Administrator access is required.");
    if (action === "save") {
      await db.batch([
        stmt(db,`UPDATE organizations SET group_creation=?,group_approval=?,member_management=?,message_forwarding=?,
          message_retention_days=?,external_messaging=?,message_changes=? WHERE id=?`,
          pick(data.creation,["Super Admin","Managers","All staff"],"group creation policy"),
          pick(data.approval,["0","1"],"approval policy")==="1"?1:0,
          pick(data.members,["Super Admin","Owners","Members"],"participant management policy"),
          pick(data.forwarding,["Disabled","Managers","All staff"],"forwarding policy"),
          integer(data.retentionDays,"message retention days",0,3650),
          pick(data.external,["0","1"],"guest messaging policy")==="1"?1:0,
          pick(data.messageChanges,["Sender","Sender or Super Admin","Locked"],"message editing policy"),actor.org_id),
        audit(db,actor,"Communication policy changed","organization",actor.org_id),
      ]);
      return json({ok:true,message:"Communication policy saved."});
    }
    if (action === "apply-retention") {
      if(data.confirmation!=="ERASE") return fail(400,"Type ERASE to confirm permanent removal of expired message content.");
      await db.transaction(async (tx) => {
        await one(tx,"SELECT id FROM organizations WHERE id=? FOR UPDATE",actor.org_id);
        const policy=await communicationPolicy(tx,actor);
        if(!policy.message_retention_days) return fail(409,"Set a message retention period first.");
        const cutoff=retentionCutoff(policy.message_retention_days);
        await run(tx,`DELETE FROM message_reactions WHERE message_id IN (
          SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.org_id=? AND m.created_at<?
        )`,actor.org_id,cutoff);
        await run(tx,`UPDATE messages SET body='',deleted_at=?,pinned=0 WHERE deleted_at IS NULL AND created_at<?
          AND conversation_id IN (SELECT id FROM conversations WHERE org_id=?)`,now(),cutoff,actor.org_id);
        await audit(tx,actor,"Message retention applied","organization",actor.org_id).run();
      });
      return json({ok:true,message:"Expired message content cleared."});
    }
    return fail(404,"Communication policy action unavailable.");
  }

  if (area === "website") {
    requireSuper(actor);
    if (action === "inquiry") {
      const target = str(data.id, "inquiry", 80);
      const status = pick(data.status, inquiryStatuses, "request status");
      const update = str(data.update, "customer update", 2000, false);
      await db.transaction(async (tx) => {
        const result = await run(tx, "UPDATE inquiries SET status=?,customer_update=?,updated_at=? WHERE id=? AND customer_id IS NOT NULL AND kind='inquiry'",
          status, update || null, now(), target);
        if (!result.count) return fail(404, "Customer request not found.");
        await audit(tx, actor, "Customer request updated", "inquiry", target).run();
      });
      return json({ ok: true, message: "Customer request updated." });
    }
    if (action === "copy") {
      await db.batch([
        stmt(db,`INSERT INTO site_content (id,title,description,about) VALUES ('home',?,?,?)
          ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,about=excluded.about`,
          str(data.title,"homepage title",120),str(data.description,"homepage introduction",350),str(data.about,"about copy",1000)),
        audit(db,actor,"Homepage content updated","website"),
      ]);
      return json({ ok:true, message:"Homepage copy updated." });
    }
    if (action === "service") {
      const target = str(data.id,"service ID",100,false) || id();
      const icon = pick(data.icon, [...divisions.map((item) => item.icon), "services"], "service icon");
      await db.batch([
        stmt(db,`INSERT INTO services (id,name,description,icon,sort) VALUES (?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,icon=excluded.icon,sort=excluded.sort`,
          target,str(data.name,"service name",100),str(data.description,"service description",450),icon,integer(data.sort || "0","display order",0,1000)),
        audit(db,actor,"Service saved","service",target),
      ]);
      return json({ ok:true, message:"Service saved." });
    }
    if (action === "archive") {
      const target = str(data.id,"service",100);
      const archived = data.archived === "1" ? 1 : 0;
      await db.batch([stmt(db,"UPDATE services SET archived=? WHERE id=?",archived,target),audit(db,actor,archived?"Service archived":"Service restored","service",target)]);
      return json({ ok:true, message:archived?"Service archived.":"Service restored." });
    }
    if (action === "market") {
      const code = country(data.country);
      await db.batch([
        stmt(db,`INSERT INTO markets (code,enabled,contact) VALUES (?,?,?)
          ON CONFLICT(code) DO UPDATE SET enabled=excluded.enabled,contact=excluded.contact`,code,data.enabled==="1"?1:0,str(data.contact,"contact information",400,false)),
        audit(db,actor,"Country configuration updated","market",code),
      ]);
      return json({ ok:true, message:"Country settings saved." });
    }
    if (action === "availability") {
      const code = country(data.country);
      const service = str(data.service,"service",100);
      const link = destination(data.destination);
      const enabled = data.enabled === "1" ? 1 : 0;
      if (!await one(db,"SELECT id FROM services WHERE id=? AND archived=0",service)) return fail(404,"Service unavailable.");
      if (!await one(db,"SELECT code FROM markets WHERE code=?",code)) return fail(400,"Save the country settings first.");
      if (enabled && !link) return fail(400,"Set an approved service destination before publishing.");
      await db.batch([
        stmt(db,`INSERT INTO availability (id,country,service_id,enabled,destination) VALUES (?,?,?,?,?)
          ON CONFLICT(country,service_id) DO UPDATE SET enabled=excluded.enabled,destination=excluded.destination`,id(),code,service,enabled,link),
        audit(db,actor,"Service availability updated","service",service),
      ]);
      return json({ ok:true, message:"Service availability saved." });
    }
  }
  if(area==="integrations"&&action==="migrate-encryption"){
    requireSuper(actor);
    if(process.env.WALSHKEN_ALLOW_LEGACY_MIGRATION!=="1")return fail(409,"Legacy key migration is not enabled on this deployment.");
    if(!process.env.WALSHKEN_INTEGRATION_KEY||!process.env.WALSHKEN_INTEGRATION_KEY_V2)return fail(409,"Run this migration in the earlier preview after both encryption keys are configured there.");
    await throttle(db,`staff-mfa:${actor.id}`,8,300000);
    return db.transaction(async tx=>{
      const credential=await one<{password_hash:string}>(tx,"SELECT password_hash FROM credentials WHERE employee_id=? FOR UPDATE",actor.id);
      const password=str(data.password,"current password",160);
      if(!await passwordMatches(password,credential?.password_hash))return fail(401,"Current password is incorrect.");
      await verifyStaffMfa(tx,actor.id,data.code,true);
      const factors=await all<{employee_id:string;secret:string;pending_secret:string|null}>(tx,"SELECT f.employee_id,f.secret,f.pending_secret FROM staff_mfa f JOIN employees e ON e.id=f.employee_id WHERE e.org_id=? FOR UPDATE OF f",actor.org_id);
      let migrated=0;
      for(const factor of factors){
        const secret=factor.secret.startsWith("v2.")?factor.secret:await encryptSettings(`staff-mfa:${factor.employee_id}`,await decryptSettings(`staff-mfa:${factor.employee_id}`,factor.secret));
        const pending=factor.pending_secret&&!factor.pending_secret.startsWith("v2.")?await encryptSettings(`staff-mfa:${factor.employee_id}`,await decryptSettings(`staff-mfa:${factor.employee_id}`,factor.pending_secret)):factor.pending_secret;
        if(secret!==factor.secret||pending!==factor.pending_secret){await run(tx,"UPDATE staff_mfa SET secret=?,pending_secret=? WHERE employee_id=?",secret,pending,factor.employee_id);migrated++;}
      }
      for(const integration of await all<{id:string;configuration:string}>(tx,"SELECT id,configuration FROM integrations FOR UPDATE"))if(!integration.configuration.startsWith("v2."))
        await run(tx,"UPDATE integrations SET configuration=?,updated_at=? WHERE id=?",await encryptSettings(integration.id,await decryptSettings(integration.id,integration.configuration)),now(),integration.id);
      await audit(tx,actor,"Encrypted staff factors and integrations migrated without changing authenticator secrets","security migration").run();
      return json({ok:true,message:`Encryption migration completed for ${migrated} authenticator records. Passwords and authenticator codes are unchanged.`});
    });
  }
  if (area === "integrations" && (action === "save" || action === "disable")) {
    requireSuper(actor);
    const provider = providers.find((item) => item.id === data.provider);
    if (!provider) return fail(400,"Choose a listed integration.");
    if(provider.id==="livekit"&&await one(db,"SELECT id FROM meetings WHERE provider='livekit' AND provider_room IS NOT NULL AND ended_at IS NULL AND cancelled_at IS NULL LIMIT 1"))return fail(409,"End active LiveKit meetings before changing the connection.");
    if(provider.id==="livekit"&&await one(db,"SELECT id FROM meeting_recordings WHERE status IN ('Starting','Active','Stopping') LIMIT 1"))return fail(409,"Wait for recordings to finish before changing the LiveKit connection.");
    if(provider.id==="recording-storage"&&action==="save"&&await one(db,"SELECT id FROM meeting_recordings WHERE deleted_at IS NULL LIMIT 1"))return fail(409,"Keep the current storage connection until all retained recordings are deleted. This prevents inaccessible recordings.");
    if (action === "disable") {
      if(provider.id==="recording-storage"&&await one(db,"SELECT id FROM meeting_recordings WHERE status IN ('Starting','Active','Stopping') LIMIT 1"))return fail(409,"Stop active recordings before disabling storage.");
      await db.batch([stmt(db,"UPDATE integrations SET enabled=0,updated_at=? WHERE id=?",now(),provider.id),audit(db,actor,"Integration disabled","integration",provider.id)]);
      return json({ ok:true,message:"Integration disabled." });
    }
    const settings: Record<string,string> = {};
    for (const [key, label] of provider.fields) settings[key] = str(data[key],label,400);
    if(provider.id==="livekit") {
      validateLiveKit(settings as LiveKitSettings);
      if(data.enabled==="1") await verifyLiveKitConnection(settings as LiveKitSettings);
    }
    if(provider.id==="recording-storage") {
      validateStorage(settings as RecordingStorage);
      if(data.enabled==="1") await verifyRecordingStorage(settings as RecordingStorage);
    }
    const protectedValue = await encryptSettings(provider.id, settings);
    await db.batch([
      stmt(db,`INSERT INTO integrations (id,configuration,enabled,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET configuration=excluded.configuration,enabled=excluded.enabled,updated_at=excluded.updated_at`,
        provider.id,protectedValue,data.enabled==="1"?1:0,now()),
      audit(db,actor,"Integration credentials rotated","integration",provider.id),
    ]);
    return json({ ok:true,message:"Integration settings saved securely." });
  }
  if (area === "holidays" && action === "add") {
    if (!canPayroll(actor)) return fail(403,"Payroll access is required.");
    const target=id();
    await db.batch([
      stmt(db,"INSERT INTO holidays (id,org_id,name,on_date,jurisdiction,type) VALUES (?,?,?,?,?,?)",target,actor.org_id,
        str(data.name,"holiday name",100),date(data.onDate,"holiday date"),str(data.jurisdiction,"jurisdiction",30),pick(data.type,["Company observance","Statutory calendar reference"],"holiday type")),
      audit(db,actor,"Holiday recorded","holiday",target),
    ]);
    return json({ok:true,message:"Holiday added to the calendar."},201);
  }
  return fail(404, "That admin action is unavailable.");
}
