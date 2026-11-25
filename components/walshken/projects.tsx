"use client";

import { ActionForm, dateText, Disclosure, options, Panel, Status, Table, type Field, type RecordRow } from "./ui";

export type ProjectsData = {
  rows: RecordRow[];
  milestones: RecordRow[];
  owners: RecordRow[];
  canCreate: boolean;
  canExport: boolean;
  query: string;
  status: string;
  order: string;
  page: number;
  total: number;
};

const states = ["Planned", "Active", "On hold", "In review", "Completed", "Cancelled", "Archived"];
const editable = states.slice(0, 3);

export function ProjectsWorkspace({ data, refresh, setQuery }: { data: ProjectsData; refresh: () => void; setQuery: (query: string) => void }) {
  const query = (page: number) => new URLSearchParams({ q: data.query, status: data.status, order: data.order, page: String(page) }).toString();
  const fields = (row?: RecordRow): Field[] => [
    { name: "name", label: "Project name", value: row?.name, required: true, max: 120 },
    { name: "description", label: "Description", value: row?.description, type: "textarea", max: 2000 },
    { name: "owner", label: "Owner", value: row?.owner_id, options: options(data.owners), required: true },
    { name: "status", label: "Status", value: row?.status ?? "Active", options: row ? editable : editable.slice(0, 2), required: true },
    { name: "start", label: "Start date", value: row?.starts_on, type: "date" },
    { name: "due", label: "Deadline", value: row?.due_on, type: "date" },
  ];
  return <Panel title="Projects" note="Manage ownership, milestones and completion reviews.">
    <form key={query(data.page)} className="staff-form" onSubmit={event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      setQuery(new URLSearchParams({ q: String(form.get("q") ?? ""), status: String(form.get("status") ?? ""), order: String(form.get("order") ?? "Recent") }).toString());
    }}>
      <div className="staff-fields">
        <label>Find a project<input name="q" type="search" defaultValue={data.query} maxLength={100}/></label>
        <label>Status<select name="status" defaultValue={data.status}><option value="">All statuses</option>{states.map(state => <option key={state}>{state}</option>)}</select></label>
        <label>Order by<select name="order" defaultValue={data.order}><option>Recent</option><option>Deadline</option><option>Name</option></select></label>
      </div>
      <button className="btn btn-outline btn-small">Apply filters</button>
    </form>
    {data.canExport&&<p><a className="btn btn-outline btn-small" href={`/api/workspace/view/projects?${query(1)}&export=1`}>Download project report</a></p>}
    {data.canCreate && <Disclosure title="Create project"><ActionForm path="projects/add" fields={fields()} submit="Create project" refresh={refresh}/></Disclosure>}
    <Table rows={data.rows} empty="No projects match these filters" columns={[
      { key: "name", title: "Project" }, { key: "owner", title: "Owner" },
      { key: "due_on", title: "Deadline", render: row => dateText(row.due_on) },
      { key: "milestones_overdue",title:"Overdue milestones",render:row=>["Completed","Cancelled","Archived"].includes(String(row.status))?"—":String(row.milestones_overdue) },
      { key: "tasks", title: "Visible tasks", render: row => `${row.tasks_done} of ${row.tasks} completed` },
      { key: "status", title: "Status", render: row => <Status>{row.status}</Status> },
    ]}/>
    {(data.page > 1 || data.total > 25) && <nav className="row-actions" aria-label="Project pages">
      <button className="btn btn-outline btn-small" disabled={data.page === 1} onClick={() => setQuery(query(data.page - 1))}>Previous</button>
      <span>Page {data.page}</span>
      <button className="btn btn-outline btn-small" disabled={data.page * 25 >= data.total} onClick={() => setQuery(query(data.page + 1))}>Next</button>
    </nav>}
    {data.rows.map(row => {
      const extra = { id: row.id, revision: row.revision };
      const canManage = Number(row.can_manage) === 1;
      const canEdit = canManage && editable.includes(String(row.status));
      const milestones = data.milestones.filter(item => item.project_id === row.id);
      const transition = row.status === "Archived" ? "restore" : ["Completed", "Cancelled"].includes(String(row.status)) ? "archive" : canEdit ? "cancel" : null;
      return <Disclosure key={String(row.id)} title={`${row.name} · ${milestones.filter(item => item.completed_at).length}/${milestones.length} milestones completed`}>
        {row.description && <p>{row.description}</p>}
        {canEdit && <Disclosure title="Edit project plan"><ActionForm key={String(row.revision)} path="projects/edit" fields={fields(row)} extra={extra} submit="Save project plan" refresh={refresh}/></Disclosure>}
        <Table rows={milestones} empty="No milestones added" columns={[
          { key: "title", title: "Milestone" }, { key: "due_on", title: "Deadline", render: item => dateText(item.due_on) },
          { key: "completed_at", title: "Status", render: item => <Status>{item.completed_at ? "Completed" : "Open"}</Status> },
        ]} actions={canEdit ? item => !item.completed_at && <Disclosure title="Manage milestone">
          <ActionForm key={String(row.revision)} path="projects/milestone-edit" fields={[
            { name: "title", label: "Milestone name", value: item.title, required: true }, { name: "due", label: "Deadline", type: "date", value: item.due_on, required: true },
          ]} extra={{...extra,milestone:item.id}} submit="Save milestone" refresh={refresh}/>
          <ActionForm path="projects/milestone-complete" fields={[]} extra={{...extra,milestone:item.id}} submit="Mark complete" refresh={refresh}/>
        </Disclosure> : undefined}/>
        {canEdit && <Disclosure title="Add milestone"><ActionForm path="projects/milestone-add" extra={extra} fields={[
          { name: "title", label: "Milestone name", required: true }, { name: "due", label: "Deadline", type: "date", required: true },
        ]} submit="Add milestone" refresh={refresh}/></Disclosure>}
        {canManage && row.status === "Active" && <Disclosure title="Submit for review"><p>Complete open tasks and milestones before submitting.</p><ActionForm path="projects/submit" extra={extra} fields={[]} submit="Submit project" refresh={refresh}/></Disclosure>}
        {row.status === "In review" && Number(row.can_review) === 1 && <Disclosure title="Review completion"><ActionForm path="projects/review" extra={extra} fields={[
          { name: "decision", label: "Decision", options: ["Approve", "Return"], required: true }, { name: "reason", label: "Review reason", type: "textarea", required: true },
        ]} submit="Record decision" refresh={refresh}/></Disclosure>}
        {canManage && transition && <Disclosure title={`Confirm ${transition}`}><p>{transition === "restore" ? "Restore the previous status." : "Preserve the project history and close the record for new work."}</p>
          <ActionForm path={`projects/${transition}`} extra={extra} fields={[]} submit={transition[0].toUpperCase() + transition.slice(1) + " project"} refresh={refresh}/>
        </Disclosure>}
      </Disclosure>;
    })}
  </Panel>;
}
