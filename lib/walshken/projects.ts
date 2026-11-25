import { actionScope, hasAction, requireEmployeeAction } from "./staff-authority";
import { all, audit, canSuper, date, fail, id, integer, json, now, one, pick, requireStaff, run, str, type Actor, type Db } from "./server";
import { taskDataset } from "./tasks";

import { permissionScope, staffReadinessEnabled } from "./staff-permissions";

export const projectLifecycleEnabled = () => process.env.WALSHKEN_PROJECT_LIFECYCLE_ENABLED === "1";
const statuses = ["Planned", "Active", "On hold", "In review", "Completed", "Cancelled", "Archived"] as const;
const mutable = ["Planned", "Active", "On hold"] as const;
type Project = {
  id: string;
  owner_id: string;
  department_id: string | null;
  status: string;
  revision: number;
  starts_on: string | null;
  due_on: string | null;
  submitted_by: string | null;
  archived_from: string | null;
};

export async function projectsView(db: Db, actor: Actor, params: URLSearchParams) {
  requireStaff(actor);
  const query = str(params.get("q"), "search", 100, false);
  const status = str(params.get("status"), "status", 24, false);
  if (status) pick(status, statuses, "project status");
  const exportReport = params.get("export") === "1";
  const page = integer(params.get("page") ?? 1, "page", 1, 10000);
  const order = pick(params.get("order") ?? "Recent", ["Recent", "Deadline", "Name"], "sort order");
  const sorts = { Recent: "p.created_at DESC", Deadline: "p.due_on ASC NULLS LAST", Name: "lower(p.name)" };
  const manage = actionScope(actor, "projects.manage", "owner", true);
  const review = actionScope(actor, "projects.review", "owner", false);
  const stage = taskDataset();
  if(exportReport&&!hasAction(actor,"projects.export"))return fail(403,"Project reporting export is outside your authority.");
  const fallback={sql:`(?=1 OR p.owner_id=? OR p.department_id=? OR (${manage.sql}) OR (${review.sql})
    OR EXISTS(SELECT 1 FROM tasks t WHERE t.project_id=p.id AND t.release_stage=? AND t.employee_id=?))`,
    args:[canSuper(actor)?1:0,actor.id,actor.department_id,...manage.args,...review.args,stage,actor.id]};
  const read=canSuper(actor)||!staffReadinessEnabled()?fallback:permissionScope(actor.permissions??[],"projects.read","owner",fallback);
  const exportScope=exportReport?actionScope(actor,"projects.export","owner",true):{sql:"1=1",args:[]};
  const rows = await all(db, `
    SELECT p.*, owner.name AS owner, d.name AS department,
      count(*) OVER()::int AS total_rows,
      (SELECT count(*)::int FROM project_milestones m WHERE m.project_id=p.id) AS milestone_count,
      (SELECT count(*)::int FROM project_milestones m WHERE m.project_id=p.id AND m.completed_at IS NOT NULL) AS milestones_done,
      (SELECT count(*)::int FROM project_milestones m WHERE m.project_id=p.id AND m.completed_at IS NULL AND m.due_on<?) AS milestones_overdue,
      CASE WHEN (${manage.sql}) THEN 1 ELSE 0 END AS can_manage,
      CASE WHEN (${review.sql}) AND p.submitted_by<>? AND p.owner_id<>? THEN 1 ELSE 0 END AS can_review,
      (SELECT count(*)::int FROM tasks t WHERE t.project_id=p.id AND t.release_stage=?
        AND (?=1 OR p.owner_id=? OR t.employee_id=?)) AS tasks,
      (SELECT count(*)::int FROM tasks t WHERE t.project_id=p.id AND t.release_stage=? AND t.status='Completed'
        AND (?=1 OR p.owner_id=? OR t.employee_id=?)) AS tasks_done
    FROM projects p JOIN employees owner ON owner.id=p.owner_id AND owner.org_id=p.org_id
    LEFT JOIN units d ON d.id=p.department_id AND d.org_id=p.org_id
    WHERE p.org_id=? AND (${read.sql}) AND (${exportScope.sql})
      AND (?='' OR p.status=?) AND (?='' OR strpos(lower(concat_ws(' ',p.name,p.description,owner.name)),lower(?))>0)
    ORDER BY ${sorts[order]},p.id LIMIT ? OFFSET ?`,
    now().slice(0,10),...manage.args, ...review.args, actor.id, actor.id,
    stage, canSuper(actor)?1:0, actor.id, actor.id,
    stage, canSuper(actor)?1:0, actor.id, actor.id,
    actor.org_id,...read.args,...exportScope.args,status,status,query,query,exportReport?1001:25,exportReport?0:(page-1)*25);
  if(exportReport){
    if(rows.length>1000)return fail(400,"Filter project status or name to export up to 1,000 records.");
    const cells=[["Project","Owner","Department","Status","Start","Deadline","Milestones","Completed milestones","Overdue milestones","Visible tasks","Completed visible tasks"],
      ...rows.map(row=>[row.name,row.owner,row.department,row.status,row.starts_on,row.due_on,row.milestone_count,row.milestones_done,row.milestones_overdue,row.tasks,row.tasks_done])];
    const quote=(value:unknown)=>'"'+String(value??"").replace(/^\s*[=+@-]|^[\t\r\n]/,"'$&").replaceAll('"','""')+'"';
    await audit(db,actor,"Project report exported","project report",String(rows.length)).run();
    return new Response("\uFEFF"+cells.map(row=>row.map(quote).join(",")).join("\r\n"),{headers:{
      "Content-Type":"text/csv; charset=utf-8","Content-Disposition":'attachment; filename="project-report.csv"',
      "Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"
    }});
  }
  const visible = rows.map(row => row.id);
  const [milestones, owners] = await Promise.all([
    visible.length ? all(db, `SELECT * FROM project_milestones WHERE project_id IN (${visible.map(() => "?").join(",")}) ORDER BY due_on,id`, ...visible) : [],
    hasAction(actor, "projects.manage") ? all(db, `SELECT owner.id,owner.name FROM employees owner
      WHERE owner.org_id=? AND owner.role<>'guest' AND owner.status='Active' AND owner.employment_status<>'Ended'
      AND (${manage.sql}) ORDER BY owner.name`, actor.org_id, ...manage.args) : [],
  ]);
  return json({ managedProjects:true, rows, milestones, owners, canCreate: owners.length > 0, canExport:hasAction(actor,"projects.export"), query, status, order, page, total: Number(rows[0]?.total_rows ?? 0) });
}

async function ownerFor(db: Db, actor: Actor, target: string) {
  await requireEmployeeAction(db, actor, "projects.manage", target);
  const owner = await one<{department_id: string | null}>(db, `SELECT department_id FROM employees
    WHERE id=? AND org_id=? AND status='Active' AND employment_status<>'Ended' AND role<>'guest'`, target, actor.org_id);
  if (!owner) return fail(400, "Choose an active project owner.");
  return owner;
}

function details(data: Record<string, unknown>) {
  const start = date(data.start, "start date", false);
  const due = date(data.due, "deadline", false);
  if (start && due && start > due) return fail(400, "The deadline must be on or after the start date.");
  return { name: str(data.name, "project name", 120), description: str(data.description, "description", 2000, false), start, due };
}

export async function projectAction(db: Db, actor: Actor, action: string, data: Record<string, unknown>) {
  requireStaff(actor);
  return db.transaction(async tx => {
    await one(tx,"SELECT id FROM organizations WHERE id=? FOR UPDATE",actor.org_id);
    if (action === "add") {
      const ownerId = str(data.owner ?? actor.id, "project owner", 80);
      const owner = await ownerFor(tx, actor, ownerId);
      const entry = details(data);
      const projectId = id();
      const status = pick(data.status ?? "Active", ["Planned", "Active"], "project status");
      await run(tx, `INSERT INTO projects(id,org_id,owner_id,department_id,name,description,status,starts_on,due_on)
        VALUES(?,?,?,?,?,?,?,?,?)`, projectId, actor.org_id, ownerId, owner.department_id, entry.name, entry.description, status, entry.start, entry.due);
      await audit(tx, actor, "Project created", "project", projectId).run();
      return json({ok:true,id:projectId,message:"Project created."}, 201);
    }
    const target = str(data.id, "project", 80);
    const project = await one<Project>(tx, "SELECT * FROM projects WHERE org_id=? AND id=? FOR UPDATE", actor.org_id, target);
    if (!project) return fail(404, "Project unavailable.");
    await requireEmployeeAction(tx, actor, action === "review" ? "projects.review" : "projects.manage", project.owner_id, action !== "review");
    if (integer(data.revision, "revision", 1, 2147483647) !== project.revision) return fail(409, "The project changed. Refresh and try again.");
    let event: string;
    if (action === "edit") {
      if (!mutable.includes(project.status as typeof mutable[number])) return fail(409, "Reopen the work before editing its plan.");
      const entry = details(data);
      const ownerId = str(data.owner, "project owner", 80);
      const owner = await ownerFor(tx, actor, ownerId);
      const outOfRange = await one(tx, `SELECT id FROM project_milestones WHERE project_id=?
        AND ((?<>'' AND due_on<?) OR (?<>'' AND due_on>?)) LIMIT 1`,
        target, entry.start??"", entry.start??"", entry.due??"", entry.due??"");
      if (outOfRange) return fail(409, "Move milestones into the new date range first.");
      await run(tx, "UPDATE projects SET name=?,description=?,owner_id=?,department_id=?,starts_on=?,due_on=?,status=? WHERE id=?",
        entry.name, entry.description, ownerId, owner.department_id, entry.start, entry.due, pick(data.status, mutable, "project status"), target);
      event = "Project plan updated";
    } else if (action === "milestone-add" || action === "milestone-complete" || action === "milestone-edit") {
      if (!mutable.includes(project.status as typeof mutable[number])) return fail(409, "A project in review or closed cannot change milestones.");
      if (action === "milestone-complete") {
        const m = await run(tx, "UPDATE project_milestones SET completed_at=? WHERE project_id=? AND id=? AND completed_at IS NULL",
          now(), target, str(data.milestone, "milestone", 80));
        if (!m.count) return fail(404, "Open milestone unavailable.");
        event = "Project milestone completed";
      } else {
        const due = date(data.due, "milestone deadline")!;
        if ((project.starts_on && due < project.starts_on) || (project.due_on && due > project.due_on)) return fail(400, "Choose a date inside the project schedule.");
        const title = str(data.title, "milestone title", 120);
        if (action === "milestone-add") await run(tx, `INSERT INTO project_milestones(id,project_id,title,due_on,created_by,created_at)
          VALUES(?,?,?,?,?,?)`, id(), target, title, due, actor.id, now());
        else {
          const changed = await run(tx, "UPDATE project_milestones SET title=?,due_on=? WHERE project_id=? AND id=? AND completed_at IS NULL",
            title, due, target, str(data.milestone, "milestone", 80));
          if (!changed.count) return fail(404, "Open milestone unavailable.");
        }
        event = action === "milestone-add" ? "Project milestone added" : "Project milestone updated";
      }
    } else if (action === "submit") {
      if (project.status !== "Active") return fail(409, "Only an active project can be submitted.");
      const open = await one(tx, `SELECT id FROM project_milestones WHERE project_id=? AND completed_at IS NULL
        UNION ALL SELECT id FROM tasks WHERE org_id=? AND project_id=? AND release_stage=? AND status NOT IN ('Completed','Cancelled') LIMIT 1`,
        target, actor.org_id, target, taskDataset());
      if (open) return fail(409, "Complete project milestones and close open tasks before submitting.");
      await run(tx, "UPDATE projects SET status='In review',submitted_by=?,submitted_at=? WHERE id=?", actor.id, now(), target);
      event = "Project submitted for approval";
    } else if (action === "review") {
      if (project.status !== "In review") return fail(409, "This project is not waiting for approval.");
      if (actor.id === project.submitted_by || actor.id === project.owner_id) return fail(403, "A different authorized reviewer must decide.");
      const decision = pick(data.decision, ["Approve", "Return"], "decision");
      const reason = str(data.reason, "review reason", 500);
      if (decision === "Approve" && await one(tx, `SELECT id FROM tasks WHERE org_id=? AND project_id=? AND release_stage=?
        AND status NOT IN ('Completed','Cancelled') LIMIT 1`, actor.org_id, target, taskDataset())) return fail(409, "Close outstanding tasks before approval.");
      await run(tx, "UPDATE projects SET status=?,completed_at=? WHERE id=?", decision==="Approve"?"Completed":"Active", decision==="Approve"?now():null, target);
      event = `Project ${decision === "Approve" ? "approved" : "returned"} · ${reason}`;
    } else if (action === "cancel" || action === "archive" || action === "restore") {
      if (action === "cancel" && !mutable.includes(project.status as typeof mutable[number])) return fail(409, "Only open projects can be cancelled.");
      if (action === "archive" && !["Completed", "Cancelled"].includes(project.status)) return fail(409, "Complete or cancel the project before archiving.");
      if (action === "restore" && (project.status !== "Archived" || !project.archived_from)) return fail(409, "This project cannot be restored.");
      const next = action === "cancel" ? "Cancelled" : action === "archive" ? "Archived" : project.archived_from;
      await run(tx, "UPDATE projects SET status=?,archived_from=? WHERE id=?", next, action === "archive" ? project.status : null, target);
      event = action === "cancel" ? "Project cancelled" : action === "archive" ? "Project archived" : "Project restored";
    } else return fail(404, "Project action unavailable.");
    await run(tx, "UPDATE projects SET revision=revision+1 WHERE id=?", target);
    await audit(tx, actor, event, "project", target).run();
    return json({ok:true,message:"Project updated."});
  });
}
