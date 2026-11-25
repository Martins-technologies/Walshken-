"use client";

import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import {
  arrivalStatuses, performanceFactors, type ArrivalStatus, type CompletionMetrics,
  type PerformanceFactor, type PerformancePage, type RankedEmployee,
} from "@/lib/walshken/staff-performance-types";
import "./staff-performance.css";

const tabs = ["Top performers","Attendance & arrival","Punctuality","Departments","Project completion","Monthly trends"] as const;
const pageLabels = ["employees", "arrival", "punctuality"] as const;
type PageKind = typeof pageLabels[number];
type Filters = {month: string; department: string; employee: string; q: string; arrivalStatus: string};
const months = Array.from({length:12}, (_, index) => new Intl.DateTimeFormat("en",{month:"long",timeZone:"UTC"}).format(new Date(Date.UTC(2024,index,1))));
const current = new Date().toISOString().slice(0,7);
const periodLabel = (month: string) => months[Number(month.slice(5,7))-1] + " " + month.slice(0,4);
const number = (value: number | null, suffix = "") => value === null ? "—" : value.toLocaleString("en",{maximumFractionDigits:1}) + suffix;
const fraction = (item: CompletionMetrics) => item.due ? `${item.completed} / ${item.due}` : "—";
const emptyFilters: Filters = {month:current,department:"",employee:"",q:"",arrivalStatus:""};

function displayInstant(value: string | null, timeZone: string) {
  if (!value) return "—";
  const zone = ["America/Edmonton","Canada/Mountain"].includes(timeZone) && value >= "2026-11-01T00:00:00Z" ? "Etc/GMT+6" : timeZone;
  return new Intl.DateTimeFormat("en",{dateStyle:"medium",timeStyle:"short",timeZone:zone}).format(new Date(value));
}

async function call(query: string, signal?: AbortSignal, body?: Record<string,unknown>) {
  const response = await fetch("/api/staff-performance" + query, {
    signal,cache:"no-store",
    ...(body ? { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The report could not be loaded.");
  return result;
}

function Table({headings,children,label}:{headings:string[];children:ReactNode;label:string}) {
  return <div className="perf-scroll"><table aria-label={label}><thead><tr>{headings.map(text=><th key={text} scope="col">{text}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}

function Pagination({kind,report,change}:{kind:PageKind;report:PerformancePage;change:(value:number)=>void}) {
  const page=report.pages[kind], max=Math.max(1,Math.ceil(report.totals[kind]/report.pageSize));
  if (max === 1) return null;
  return <div className="perf-pagination" aria-label="Report pages">
    <button type="button" className="btn btn-outline btn-small" onClick={()=>change(page-1)} disabled={page===1}>Previous</button>
    <span>Page {page} of {max}</span>
    <button type="button" className="btn btn-outline btn-small" onClick={()=>change(page+1)} disabled={page===max}>Next</button>
  </div>;
}

function PersonCard({person}: {person: RankedEmployee}) {
  const [photoFailed,setPhotoFailed]=useState(false);
  return <article className="perf-leader">
    <div className="perf-leader-heading">
      <span className="perf-avatar" aria-hidden="true">{person.hasPhoto&&!photoFailed
        ? <img src={"/api/staff-performance?photo="+encodeURIComponent(person.id)} alt="" onError={()=>setPhotoFailed(true)}/>
        : person.name.split(/\s+/).slice(0,2).map(word=>word[0]).join("").toUpperCase()}</span>
      <div><small>Position {person.rank}</small><h5>{person.name}</h5><p>{person.department} · {person.designation}</p></div>
    </div>
    <strong className="perf-score">{number(person.score)} <small>/ 100</small></strong>
    <dl>
      <div><dt>Attendance</dt><dd>{number(person.attendance.attendancePercent,"%")}</dd></div>
      <div><dt>Punctuality</dt><dd>{number(person.attendance.punctualityPercent,"%")}</dd></div>
      <div><dt>On time / early</dt><dd>{person.attendance.onTime} / {person.attendance.early}</dd></div>
      <div><dt>Late / absent</dt><dd>{person.attendance.late} / {person.attendance.absent}</dd></div>
      <div><dt>Tasks completed</dt><dd>{person.tasks.completedThisMonth}</dd></div>
      <div><dt>Projects completed</dt><dd>{person.projects.completedThisMonth}</dd></div>
      <div><dt>Milestones due completed</dt><dd>{number(person.milestones.percent,"%")}</dd></div>
      <div><dt>Weight measured</dt><dd>{person.measuredWeight}%</dd></div>
    </dl>
  </article>;
}

function Method({report}: {report: PerformancePage}) {
  const weights = Object.keys(performanceFactors) as PerformanceFactor[];
  return <details className="perf-method">
    <summary>How performance is calculated</summary>
    <p>The score is a weighted average of qualifying measurements. A factor with no applicable work is omitted and the measured weight is shown separately. A published shift with unresolved arrival evidence prevents ranking when attendance or punctuality is weighted. An enabled assessment factor requires an independently approved assessment.</p>
    <p>Attendance is recorded arrivals divided by elapsed scheduled shifts. Punctuality is early and on-time arrivals divided by recorded arrivals. Approved leave, applicable holidays, closures and excused shifts are excluded. Upcoming shifts do not affect the score.</p>
    <p>Completion uses the share of work due in the selected month that was completed by month-end. In an open month, unfinished items enter the calculation after their local due date ends. Assignment volume alone carries no points. Milestones are credited to the recorded assignee. Subjective assessments are shown separately.</p>
    <p>Ties share a position. All rankings and totals cover your authorized staff and the applied filters.</p>
    <dl className="perf-weights">{weights.map(key=><div key={key}><dt>{performanceFactors[key]}</dt><dd>{report.model.weights[key]}%</dd></div>)}</dl>
    <small>{report.model.effectiveMonth?`Effective from ${periodLabel(report.model.effectiveMonth)}`:"Standard scoring weights"}</small>
  </details>;
}

export function StaffPerformance() {
  const heading = useId();
  const [tab,setTab]=useState<typeof tabs[number]>(tabs[0]), [filter,setFilter]=useState(emptyFilters), [draft,setDraft]=useState(emptyFilters);
  const [pages,setPages]=useState({employees:1,arrival:1,punctuality:1}), [report,setReport]=useState<PerformancePage|null>(null);
  const [loading,setLoading]=useState(true), [error,setError]=useState(""), [notice,setNotice]=useState(""), [writing,setWriting]=useState(false), [version,setVersion]=useState(0);
  const params = new URLSearchParams({...filter,page:String(pages.employees),arrivalPage:String(pages.arrival),punctualityPage:String(pages.punctuality)});
  const query = "?" + params.toString();
  useEffect(()=>{
    const controller = new AbortController();
    call(query,controller.signal).then(value=>{if(!controller.signal.aborted)setReport(value);})
      .catch(reason=>{if(!controller.signal.aborted)setError(reason.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[query,version]);
  const load = (select:Filters) => {
    setError("");setLoading(true);setFilter(select);setPages({employees:1,arrival:1,punctuality:1});setVersion(value=>value+1);
  };
  const paginate = (kind:PageKind,page:number)=>{setError("");setLoading(true);setPages(prior=>({...prior,[kind]:page}));};
  async function update(data:Record<string,unknown>, form:HTMLFormElement) {
    setWriting(true);setError("");setNotice("");
    try {
      const result=await call("",undefined,{...data,month:filter.month});
      setNotice(result.message);form.reset();setVersion(value=>value+1);
    } catch (reason) { setError((reason as Error).message); }
    finally { setWriting(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>, action: string) {
    event.preventDefault();
    const form=event.currentTarget, fields=Object.fromEntries(new FormData(form));
    const weights=action==="model-save"?Object.fromEntries(Object.keys(performanceFactors).map(key=>[key,fields[key]])):undefined;
    void update({...fields,action,weights,confirm:fields.confirm==="on"},form);
  }

  return <section className="wf-panel staff-performance" aria-labelledby={heading}>
    <header><div><h3 id={heading}>Employee performance</h3><p>Review monthly outcomes based on published schedules, recorded attendance and assigned work.</p></div>
      {report&&<span className="wf-badge">{report.finalizedAt?"Finalized":"Provisional"}</span>}
    </header>
    <form className="perf-filter" onSubmit={event=>{event.preventDefault();load(draft);}}>
      <label>Month<select value={draft.month.slice(5)} onChange={event=>setDraft({...draft,month:draft.month.slice(0,5)+event.target.value})}>
        {months.map((name,index)=><option key={name} value={String(index+1).padStart(2,"0")}>{name}</option>)}</select></label>
      <label>Year<input type="number" min="1900" max="2099" required value={draft.month.slice(0,4)} onChange={event=>setDraft({...draft,month:event.target.value+"-"+draft.month.slice(-2)})}/></label>
      <label>Department<select value={draft.department} onChange={event=>setDraft({...draft,department:event.target.value,employee:""})}>
        <option value="">All authorized departments</option>{report?.departments.map(group=><option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
      <label>Employee<select value={draft.employee} onChange={event=>setDraft({...draft,employee:event.target.value})}>
        <option value="">All authorized employees</option>{report?.people.filter(person=>!draft.department||(person.departmentId??"unassigned")===draft.department)
          .map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
      <label>Search<input value={draft.q} maxLength={120} onChange={event=>setDraft({...draft,q:event.target.value})} placeholder="Name or designation"/></label>
      <button type="submit" className="btn btn-blue btn-small" disabled={loading}>Apply filters</button>
    </form>
    {notice&&<p role="status" className="form-success">{notice}</p>}
    {error&&<p role="alert" className="form-error">{error}</p>}
    {loading&&<p role="status" className="perf-empty">Loading the report…</p>}
    {!loading&&report&&<div className="perf-content">
      <div className="perf-controls">
        <nav aria-label="Performance reports">{tabs.map(title=><button key={title} type="button" aria-pressed={tab===title} onClick={()=>setTab(title)}>{title}</button>)}</nav>
        {report.canExport&&<div className="perf-downloads">{["csv","pdf"].map(format=><a key={format} className="btn btn-outline btn-small"
          href={`/api/staff-performance${query}&format=${format}&report=${tab==="Attendance & arrival"?"arrival":"performance"}`}>Export {format.toUpperCase()}</a>)}</div>}
      </div>
      {tab==="Top performers"&&<>
        <h4>Monthly top 3 performers · {periodLabel(report.month)}</h4>
        {report.leaders.length?<div className="perf-leaders">{report.leaders.map(person=><PersonCard key={person.id} person={person}/>)}</div>
          : <p className="perf-empty">There is no qualifying scored evidence for the selected month and filters.</p>}
        <Table label="Employee performance scores" headings={["Rank","Employee","Score","Attendance","Punctuality","Tasks","Projects","Milestones","Assessment","Work quality","Evidence"]}>
          {report.employees.map(row=><tr key={row.id}><td>{row.rank??"—"}</td><td>{row.name}<small>{row.department} · {row.designation}</small></td>
            <td>{number(row.score)}</td><td>{number(row.attendance.attendancePercent,"%")}</td><td>{number(row.attendance.punctualityPercent,"%")}</td>
            <td>{fraction(row.tasks)}</td><td>{fraction(row.projects)}</td><td>{fraction(row.milestones)}</td><td>{number(row.review)}</td>
            <td>{number(row.quality)}</td><td>{row.reason??`${row.measuredWeight}% measured`}</td></tr>)}
        </Table>
        <Pagination kind="employees" report={report} change={page=>paginate("employees",page)}/>
      </>}
      {tab==="Attendance & arrival"&&<>
        <div className="perf-subheading"><h4>Employee attendance and arrival</h4><label>Arrival status<select value={filter.arrivalStatus} onChange={event=>load({...filter,arrivalStatus:event.target.value as ArrivalStatus|""})}>
          <option value="">All statuses</option>{arrivalStatuses.map(status=><option key={status}>{status}</option>)}</select></label></div>
        {!report.arrival.length&&<p className="perf-empty">There are no published shifts matching these filters.</p>}
        <Table label="Scheduled and actual employee arrivals" headings={["Employee","Scheduled start","Actual arrival","Difference","Status"]}>
          {report.arrival.map(row=><tr key={row.id}><td>{row.name}</td><td>{displayInstant(row.scheduled,row.timeZone)}<small>{row.timeZone}</small></td>
            <td>{displayInstant(row.checkedIn,row.timeZone)}</td><td>{number(row.differenceMinutes," min")}</td><td>{row.status}<small>{row.reason}</small></td></tr>)}
        </Table>
        <Pagination kind="arrival" report={report} change={page=>paginate("arrival",page)}/>
      </>}
      {tab==="Punctuality"&&<>
        <h4>Punctuality ranking</h4>
        {!report.punctuality.length&&<p className="perf-empty">No employees have complete arrival evidence for this ranking.</p>}
        <Table label="Punctuality ranking" headings={["Rank","Employee","On time","Early","Late","Confirmed absent","Missing","Attendance","Punctuality"]}>
          {report.punctuality.map(row=><tr key={row.id}><td>{row.punctualityRank}</td><td>{row.name}<small>{row.department}</small></td><td>{row.attendance.onTime}</td>
          <td>{row.attendance.early}</td><td>{row.attendance.late}</td><td>{row.attendance.absent}</td><td>{row.attendance.missing}</td>
          <td>{number(row.attendance.attendancePercent,"%")}</td><td>{number(row.attendance.punctualityPercent,"%")}</td></tr>)}
        </Table>
        <Pagination kind="punctuality" report={report} change={page=>paginate("punctuality",page)}/>
      </>}
      {tab==="Departments"&&<>
        <h4>Department performance summary</h4>
        <Table label="Department performance summary" headings={["Department","Employees","Ranked","Average score","Attendance","Punctuality","Tasks","Projects","Milestones"]}>
          {report.departmentSummary.map(row=><tr key={row.id??"unassigned"}><td>{row.department}</td><td>{row.employees}</td><td>{row.ranked}</td><td>{number(row.score)}</td>
            <td>{number(row.attendance.attendancePercent,"%")}</td><td>{number(row.attendance.punctualityPercent,"%")}</td>
            <td>{fraction(row.tasks)}</td><td>{fraction(row.projects)}</td><td>{fraction(row.milestones)}</td></tr>)}
        </Table>
        {!report.departmentSummary.length&&<p className="perf-empty">No departments match this report.</p>}
      </>}
      {tab==="Project completion"&&<>
        <h4>Project completion performance</h4>
        <Table label="Assigned project and milestone completion" headings={["Employee","Department","Projects due completed","Projects completed this month","Project completion","Milestones due completed","Milestone completion","Tasks due completed"]}>
          {report.employees.map(row=><tr key={row.id}><td>{row.name}</td><td>{row.department}</td><td>{fraction(row.projects)}</td><td>{row.projects.completedThisMonth}</td>
            <td>{number(row.projects.percent,"%")}</td><td>{fraction(row.milestones)}</td><td>{number(row.milestones.percent,"%")}</td><td>{fraction(row.tasks)}</td></tr>)}
        </Table>
        {!report.employees.length&&<p className="perf-empty">No employees match this report.</p>}
        <Pagination kind="employees" report={report} change={page=>paginate("employees",page)}/>
      </>}
      {tab==="Monthly trends"&&<>
        <h4>Monthly performance trends</h4><p>Six months through {periodLabel(report.month)}.</p>
        <Table label="Monthly attendance and performance trends" headings={["Month","Status","Ranked employees","Average score","Attendance","Punctuality","Late arrivals","Absences","Tasks","Projects","Milestones"]}>
          {report.trends.map(row=><tr key={row.month}><td>{periodLabel(row.month)}</td><td>{row.finalized?"Finalized":"Provisional"}</td><td>{row.ranked} / {row.employees}</td>
           <td>{number(row.score)}</td><td>{number(row.attendance.attendancePercent,"%")}</td><td>{number(row.attendance.punctualityPercent,"%")}</td>
           <td>{row.attendance.late}</td><td>{row.attendance.absent}</td><td>{fraction(row.tasks)}</td><td>{fraction(row.projects)}</td><td>{fraction(row.milestones)}</td></tr>)}
        </Table>
      </>}
      <Method report={report}/>
      {(report.canConfigure&&!report.finalizedAt||report.canFinalize||report.canSubmitAssessment||report.assessments.length>0)&&<details className="perf-method">
        <summary>Scoring, assessments and finalization</summary>
        {report.canConfigure&&!report.finalizedAt&&<form className="perf-admin-form" key={report.model.version+report.month} onSubmit={event=>submit(event,"model-save")}>
          <h5>Scoring weights effective from {periodLabel(report.month)}</h5>
          <div className="perf-filter">{(Object.keys(performanceFactors) as PerformanceFactor[]).map(key=><label key={key}>{performanceFactors[key]}
            <input name={key} type="number" min="0" max="100" step="1" required defaultValue={report.model.weights[key]}/></label>)}</div>
          <label>Reason for the change<textarea name="reason" required maxLength={1000} rows={2}/></label>
          <button type="submit" className="btn btn-outline btn-small" disabled={writing}>Save weights totaling 100</button>
        </form>}
        {report.canSubmitAssessment&&report.reviewPeople.length>0&&<form className="perf-admin-form" onSubmit={event=>submit(event,"assessment-submit")}>
          <h5>Submit a performance assessment</h5>
          <div className="perf-filter"><label>Employee<select name="employee" required defaultValue=""><option value="" disabled>Choose employee</option>
            {report.reviewPeople.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
            <label>Manager assessment / 100<input name="reviewScore" type="number" min="0" max="100" required/></label>
            <label>Work quality / 100, if documented<input name="qualityScore" type="number" min="0" max="100"/></label></div>
          <label>Evidence and rationale<textarea name="evidence" required maxLength={1500} rows={3}/></label>
          <button type="submit" className="btn btn-outline btn-small" disabled={writing}>Submit for independent approval</button>
        </form>}
        {report.assessments.map(row=><article className="perf-assessment" key={row.id}>
          <h5>{report.people.find(person=>person.id===row.employee_id)?.name??"Employee"}</h5>
          <p>Manager assessment {row.review_score}/100 · Quality {row.quality_score===null?"not documented":row.quality_score+"/100"} · {row.decision??"Pending"}</p>
          <p>{row.evidence}</p>
          {row.canDecide&&!report.finalizedAt&&<form className="perf-admin-form" onSubmit={event=>submit(event,"assessment-decide")}>
            <input type="hidden" name="id" value={row.id}/>
            <label>Decision<select name="decision"><option>Approved</option><option>Rejected</option></select></label>
            <label>Review rationale<input name="reason" required maxLength={1000}/></label>
            <button type="submit" className="btn btn-outline btn-small" disabled={writing}>Record decision</button>
          </form>}
        </article>)}
        {report.canFinalize&&<form className="perf-admin-form" onSubmit={event=>submit(event,"finalize")}>
          <h5>Finalize {periodLabel(report.month)} for the organization</h5>
          <p>Finalization saves the current evidence and scores for all employees. Filters on this screen apply to viewing only.</p>
          <label className="perf-confirm"><input name="confirm" type="checkbox" required/> I reviewed the evidence and understand that the snapshot cannot be edited.</label>
          <button type="submit" className="btn btn-blue btn-small" disabled={writing}>Finalize monthly report</button>
        </form>}
      </details>}
    </div>}
  </section>;
}
