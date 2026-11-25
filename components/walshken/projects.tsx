"use client";

import { useState, type FormEvent } from "react";
import { ActionForm, api, dateText, Disclosure, options, Panel, Status, Table, type Field, type RecordRow } from "./ui";

export type ProjectsData = {
  rows: RecordRow[];
  milestones: RecordRow[];
  owners: RecordRow[];
  units: RecordRow[];
  assignments: RecordRow[];
  deliverables: RecordRow[];
  events: RecordRow[];
  eligible: RecordRow[];
  workload: RecordRow[];
  viewer: string;
  canCreate: boolean;
  canExport: boolean;
  query: string;
  status: string;
  order: string;
  page: number;
  target: string;
  total: number;
};

const states = ["Planned", "Active", "On hold", "In review", "Completed", "Cancelled", "Archived"];
const editable = states.slice(0, 3);
const priorities = ["Low", "Normal", "High", "Urgent"];

function MembersForm({ project, choices, selected, refresh }: {
  project: RecordRow; choices: RecordRow[]; selected: RecordRow[]; refresh: () => void;
}) {
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(""),[error,setError]=useState(false);
  const people=new Map(choices.map(person=>[String(person.id),String(person.name)]));
  for(const person of selected)people.set(String(person.employee_id),String(person.name));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    setBusy(true);setMessage("");setError(false);
    try{
      const result=await api("projects/assign",{id:project.id,revision:project.revision,employees:form.getAll("employees")});
      setMessage(result.message);refresh();
    }catch(reason){setError(true);setMessage(reason instanceof Error?reason.message:"Could not save the assignment.");}
    finally{setBusy(false);}
  }
  return <form className="staff-form" onSubmit={submit}>
    <label>Assigned employees
      <select name="employees" multiple size={Math.min(8,Math.max(3,people.size))} defaultValue={selected.map(person=>String(person.employee_id))}>
        {[...people].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,name])=><option key={id} value={id}>{name}</option>)}
      </select>
    </label>
    <p className="muted">Select everyone currently assigned to the project.</p>
    <button className="btn btn-blue btn-small" disabled={busy}>{busy?"Saving…":"Save assignments"}</button>
    {message&&<p className={error?"form-error":"form-success"} role="status">{message}</p>}
  </form>;
}

function DeliverableUpload({ project, deliverable, refresh }: { project:RecordRow;deliverable:RecordRow;refresh:()=>void }) {
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(""),[error,setError]=useState(false);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=event.currentTarget,body=new FormData(form);
    body.set("project",String(project.id));body.set("revision",String(project.revision));body.set("deliverable",String(deliverable.id));
    setBusy(true);setMessage("");setError(false);
    try{
      const response=await fetch("/api/projects/deliverable",{method:"POST",body});
      const result=await response.json().catch(()=>({error:"The upload response could not be read."}));
      if(!response.ok)throw new Error(result.error||"Could not upload this file.");
      form.reset();setMessage(result.message);refresh();
    }catch(reason){setError(true);setMessage(reason instanceof Error?reason.message:"Could not upload this file.");}
    finally{setBusy(false);}
  }
  return <form className="staff-form" onSubmit={submit}>
    <label>File to submit<input name="file" type="file" required accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp"/></label>
    <p className="muted">Choose a supported file up to 3 MB.</p>
    <button className="btn btn-blue btn-small" disabled={busy}>{busy?"Uploading…":"Upload and submit"}</button>
    {message&&<p className={error?"form-error":"form-success"} role="status">{message}</p>}
  </form>;
}

function Deliverables({ project, rows, staff, canEdit, viewer, refresh }: {
  project:RecordRow;rows:RecordRow[];staff:RecordRow[];canEdit:boolean;viewer:string;refresh:()=>void;
}) {
  const extra={id:project.id,revision:project.revision};
  const fields=(entry?:RecordRow):Field[]=>[
    {name:"title",label:"Deliverable name",value:entry?.title,required:true,max:120},
    {name:"description",label:"Submission instructions",type:"textarea",value:entry?.description,max:2000},
    {name:"due",label:"Deadline",type:"date",value:entry?.due_on,required:true},
    {name:"assignee",label:"Assigned employee",value:entry?.assignee_id,options:options(staff)},
  ];
  const isOpen=editable.includes(String(project.status));
  return <Disclosure title="Deliverables">
    {!rows.length&&<p>No deliverables have been added.</p>}
    {rows.map(row=>{
      const params=new URLSearchParams({project:String(project.id),deliverable:String(row.id),version:String(row.version_id??"")});
      const canDownload=canEdit||Number(project.can_manage)===1||project.owner_id===viewer||row.assignee_id===viewer||row.uploaded_by===viewer;
      const canUpload=isOpen&&(canEdit||Number(project.is_assigned)===1&&row.assignee_id===viewer)&&(!row.file_status||row.file_status==="Returned");
      return <Disclosure key={String(row.id)} title={`${row.title} · ${row.file_status??"Awaiting submission"}`}>
        {row.description&&<p>{row.description}</p>}
        <p>{row.assignee??"Unassigned"} · {dateText(row.due_on)}</p>
        {row.filename&&<p>{canDownload
          ? <a className="text-link" href={`/api/projects/deliverable?${params}`}>Download {row.filename}</a>
          : <span>File submitted</span>}
          {row.version&&<span> · Version {row.version}</span>}
        </p>}
        {row.review_note&&<p>{row.review_note}</p>}
        {canUpload&&<DeliverableUpload project={project} deliverable={row} refresh={refresh}/>}
        {canEdit&&row.file_status==="Submitted"&&row.uploaded_by!==viewer&&<Disclosure title="Review submitted work">
          <ActionForm path="projects/deliverable-review" fields={[
            {name:"decision",label:"Decision",options:["Approved","Returned"],required:true},
            {name:"reason",label:"Review note",type:"textarea",required:true,max:500},
          ]} extra={{...extra,deliverable:row.id,version:row.version_id}} submit="Record review" refresh={refresh}/>
        </Disclosure>}
        {canEdit&&row.file_status!=="Approved"&&<Disclosure title="Change deliverable details"><ActionForm key={String(project.revision)} path="projects/deliverable-edit" fields={fields(row)} extra={{...extra,deliverable:row.id}} submit="Save deliverable" refresh={refresh}/></Disclosure>}
        {canEdit&&(!row.file_status||row.file_status==="Returned")&&<ActionForm path="projects/deliverable-archive" fields={[]} extra={{...extra,deliverable:row.id}} submit="Archive deliverable" refresh={refresh}/>}
      </Disclosure>;
    })}
    {canEdit&&<Disclosure title="Add deliverable"><ActionForm path="projects/deliverable-add" fields={fields()} extra={extra} submit="Add deliverable" refresh={refresh}/></Disclosure>}
  </Disclosure>;
}

export function ProjectsWorkspace({ data, refresh, setQuery }: { data: ProjectsData; refresh: () => void; setQuery: (query: string) => void }) {
  const query=(page:number)=>new URLSearchParams({q:data.query,status:data.status,order:data.order,page:String(page),project:data.target}).toString();
  const fields=(row?:RecordRow):Field[]=>{
    const choices=(key:string)=>row?.[key+"_id"]&&row[key]&&!data.owners.some(person=>person.id===row[key+"_id"])
      ? [...options(data.owners),[String(row[key+"_id"]),String(row[key])] as const] : options(data.owners);
    const adminFields:Field[]=row&&Number(row.can_administer)!==1?[]:[
      {name:"owner",label:"Project owner",value:row?.owner_id,options:choices("owner"),required:true},
      {name:"manager",label:"Project manager",value:row?.manager_id??row?.owner_id,options:choices("manager"),required:true},
      {name:"department",label:"Department",value:row?.department_id,options:options(data.units.filter(unit=>unit.kind==="Department"))},
      {name:"team",label:"Team",value:row?.team_id,options:options(data.units.filter(unit=>unit.kind==="Team"))},
    ];
    return [
      {name:"name",label:"Project name",value:row?.name,required:true,max:120},
      {name:"description",label:"Description",value:row?.description,type:"textarea",max:2000},
      ...adminFields,
      {name:"priority",label:"Priority",value:row?.priority??"Normal",options:priorities,required:true},
      {name:"status",label:"Status",value:row?.status??"Active",options:row?editable:editable.slice(0,2),required:true},
      {name:"start",label:"Start date",value:row?.starts_on,type:"date"},
      {name:"due",label:"Deadline",value:row?.due_on,type:"date"},
      ...(!row?[{name:"employees",label:"Assigned employees",options:options(data.owners),multiple:true}]:[]),
    ];
  };
  return <Panel title="Projects" note="Plan projects, assign staff, and review milestones and deliverables.">
    <form key={query(data.page)} className="staff-form" onSubmit={event=>{
      event.preventDefault();
      const form=new FormData(event.currentTarget);
      setQuery(new URLSearchParams({q:String(form.get("q")??""),status:String(form.get("status")??""),order:String(form.get("order")??"Recent")}).toString());
    }}>
      <div className="staff-fields">
        <label>Find a project<input name="q" type="search" defaultValue={data.query} maxLength={100}/></label>
        <label>Status<select name="status" defaultValue={data.status}><option value="">All statuses</option>{states.map(state=><option key={state}>{state}</option>)}</select></label>
        <label>Order by<select name="order" defaultValue={data.order}><option>Recent</option><option>Deadline</option><option>Name</option></select></label>
      </div>
      <button className="btn btn-outline btn-small">Apply filters</button>
    </form>
    <div className="row-actions">
      {data.target&&<button className="btn btn-outline btn-small" onClick={()=>setQuery("")}>Show all projects</button>}
      {data.canExport&&<a className="btn btn-outline btn-small" href={`/api/workspace/view/projects?${query(1)}&export=1`}>Download project report</a>}
    </div>
    {data.canCreate&&<Disclosure title="Create project"><ActionForm path="projects/add" fields={fields()} submit="Create project" refresh={refresh}/></Disclosure>}
    <Table rows={data.rows} empty="No projects match these filters" columns={[
      {key:"name",title:"Project"},{key:"manager",title:"Project manager"},{key:"priority",title:"Priority"},{key:"team",title:"Team"},
      {key:"due_on",title:"Deadline",render:row=><>{dateText(row.due_on)} {Number(row.overdue)===1&&<Status>Overdue</Status>}</>},
      {key:"milestones_overdue",title:"Overdue milestones",render:row=>["Completed","Cancelled","Archived"].includes(String(row.status))?"—":String(row.milestones_overdue)},
      {key:"tasks",title:"Visible tasks",render:row=>`${row.tasks_done} of ${row.tasks} completed`},
      {key:"status",title:"Status",render:row=><Status>{row.status}</Status>},
    ]}/>
    {(data.page>1||data.total>25)&&<nav className="row-actions" aria-label="Project pages">
      <button className="btn btn-outline btn-small" disabled={data.page===1} onClick={()=>setQuery(query(data.page-1))}>Previous</button>
      <span>Page {data.page}</span>
      <button className="btn btn-outline btn-small" disabled={data.page*25>=data.total} onClick={()=>setQuery(query(data.page+1))}>Next</button>
    </nav>}
    {data.rows.map(row=>{
      const extra={id:row.id,revision:row.revision},canManage=Number(row.can_manage)===1;
      const canEdit=canManage&&editable.includes(String(row.status));
      const members=data.assignments.filter(item=>item.project_id===row.id),current=members.filter(item=>!item.unassigned_at);
      const assignmentChoices=Number(row.can_administer)===1?data.owners:data.eligible.filter(item=>item.project_id===row.id).map(item=>({id:item.employee_id,name:item.name}));
      const staffById=new Map(current.map(person=>[String(person.employee_id),String(person.name)]));
      if(row.owner_id&&row.owner)staffById.set(String(row.owner_id),String(row.owner));
      if(row.manager_id&&row.manager)staffById.set(String(row.manager_id),String(row.manager));
      const staff=[...staffById].map(([id,name])=>({id,name}));
      const milestones=data.milestones.filter(item=>item.project_id===row.id);
      const transition=Number(row.can_administer)!==1?null:row.status==="Archived"?"restore":["Completed","Cancelled"].includes(String(row.status))?"archive":canEdit?"cancel":null;
      return <Disclosure key={String(row.id)} title={`${row.name} · ${milestones.filter(item=>item.completed_at).length}/${milestones.length} milestones completed`}>
        {row.description&&<p>{row.description}</p>}
        <p>Owner {row.owner??"—"} · Department {row.department??"—"} · Team {row.team??"—"}</p>
        <p>Assigned employees {current.length?current.map(item=>item.name).join(", "):"None"}</p>
        {canEdit&&<Disclosure title="Edit project plan"><ActionForm key={String(row.revision)} path="projects/edit" fields={fields(row)} extra={extra} submit="Save project plan" refresh={refresh}/></Disclosure>}
        {canEdit&&<Disclosure title="Manage project assignments"><MembersForm key={String(row.revision)} project={row} choices={assignmentChoices} selected={current} refresh={refresh}/></Disclosure>}
        <Table rows={milestones} empty="No milestones added" columns={[
          {key:"title",title:"Milestone"},{key:"assignee",title:"Assigned employee"},
          {key:"due_on",title:"Deadline",render:item=>dateText(item.due_on)},
          {key:"completed_at",title:"Status",render:item=><Status>{item.completed_at?"Completed":"Open"}</Status>},
        ]} actions={editable.includes(String(row.status))?item=>!item.completed_at&&(canEdit||Number(row.is_assigned)===1&&item.assignee_id===data.viewer)&&<Disclosure title="Update milestone">
          {canEdit&&<ActionForm key={String(row.revision)} path="projects/milestone-edit" fields={[
            {name:"title",label:"Milestone name",value:item.title,required:true},{name:"due",label:"Deadline",type:"date",value:item.due_on,required:true},
            {name:"assignee",label:"Assigned employee",value:item.assignee_id,options:options(staff)},
          ]} extra={{...extra,milestone:item.id}} submit="Save milestone" refresh={refresh}/>}
          <ActionForm path="projects/milestone-complete" fields={[]} extra={{...extra,milestone:item.id}} submit="Mark complete" refresh={refresh}/>
        </Disclosure>:undefined}/>
        {canEdit&&<Disclosure title="Add milestone"><ActionForm path="projects/milestone-add" extra={extra} fields={[
          {name:"title",label:"Milestone name",required:true},{name:"due",label:"Deadline",type:"date",required:true},
          {name:"assignee",label:"Assigned employee",options:options(staff)},
        ]} submit="Add milestone" refresh={refresh}/></Disclosure>}
        <Deliverables project={row} rows={data.deliverables.filter(item=>item.project_id===row.id)} staff={staff} canEdit={canEdit} viewer={data.viewer} refresh={refresh}/>
        <Disclosure title="Workload and activity">
          <Table rows={data.workload.filter(item=>item.project_id===row.id)} empty="No assigned work" columns={[
            {key:"name",title:"Employee"},{key:"tasks",title:"Tasks completed",render:item=>`${item.tasks_done} of ${item.tasks}`},
            {key:"milestones",title:"Milestones completed",render:item=>`${item.milestones_done} of ${item.milestones}`},
          ]}/>
          <Table rows={members} empty="No assignment history" columns={[
            {key:"name",title:"Employee"},{key:"assigned_at",title:"Assigned",render:item=>dateText(item.assigned_at)},
            {key:"unassigned_at",title:"Assignment ended",render:item=>dateText(item.unassigned_at)},
          ]}/>
          <Table rows={data.events.filter(item=>item.project_id===row.id)} empty="No activity recorded" columns={[
            {key:"created_at",title:"Date",render:item=>dateText(item.created_at,true)},{key:"actor",title:"Employee"},{key:"action",title:"Activity"},
          ]}/>
        </Disclosure>
        {canManage&&row.status==="Active"&&<Disclosure title="Submit for review"><p>Complete tasks and milestones and approve deliverables before submitting.</p>
          <ActionForm path="projects/submit" extra={extra} fields={[]} submit="Submit project" refresh={refresh}/>
        </Disclosure>}
        {row.status==="In review"&&Number(row.can_review)===1&&<Disclosure title="Review completion"><ActionForm path="projects/review" extra={extra} fields={[
          {name:"decision",label:"Decision",options:["Approve","Return"],required:true},{name:"reason",label:"Review reason",type:"textarea",required:true},
        ]} submit="Record decision" refresh={refresh}/></Disclosure>}
        {canManage&&transition&&<Disclosure title={`Confirm ${transition}`}><p>{transition==="restore"?"Restore the previous status.":"Preserve the project history and close the record for new work."}</p>
          <ActionForm path={`projects/${transition}`} extra={extra} fields={[]} submit={transition[0].toUpperCase()+transition.slice(1)+" project"} refresh={refresh}/>
        </Disclosure>}
      </Disclosure>;
    })}
  </Panel>;
}
