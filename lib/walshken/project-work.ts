import { all, audit, fail, id, now, one, run, str, type Actor, type Db } from "./server";
import { accessibleProject, projectLifecycleEnabled, requireProjectPlanEmployee } from "./project-authority";
import { taskDataset } from "./tasks";

export const projectPriorities = ["Low", "Normal", "High", "Urgent"] as const;
export const editableProjectStatus = ["Planned", "Active", "On hold"] as const;
export type AccessibleProject = Awaited<ReturnType<typeof accessibleProject>>;
export type ProjectAssignment = { id: string; project_id: string; employee_id: string; assigned_at: string; unassigned_at: string|null };

export function openProject(project: AccessibleProject) {
  if (!editableProjectStatus.includes(project.status as typeof editableProjectStatus[number])) {
    return fail(409, "Return or reopen this project before changing its work.");
  }
}

export function projectRevision(project: AccessibleProject, revision: unknown) {
  if (Number(revision)!==project.revision) return fail(409, "The project changed. Refresh and try again.");
}

export async function recordProjectEvent(db: Db, actor: Actor, projectId: string, event: string) {
  await run(db, "UPDATE projects SET revision=revision+1 WHERE org_id=? AND id=?", actor.org_id, projectId);
  await audit(db, actor, event, "project", projectId).run();
}

export async function projectNotifications(db: Db, orgId: string, employeeIds: Iterable<string>, title: string, body: string, projectId: string) {
  for (const employee of new Set(employeeIds)) {
    await run(db, `INSERT INTO notifications(id,employee_id,title,body,href,release_stage)
      SELECT ?,e.id,?,?,?,? FROM employees e WHERE e.id=? AND e.org_id=? AND e.role<>'guest'
      AND e.status='Active' AND e.employment_status<>'Ended'`,
      id(),title.slice(0,150),body.slice(0,500),"/staff/projects?project="+encodeURIComponent(projectId),taskDataset(),employee,orgId);
  }
}

export async function projectPeople(db: Db, orgId: string, projectId: string) {
  const rows = await all<{ employee_id: string }>(db, `
    SELECT owner_id AS employee_id FROM projects WHERE org_id=? AND id=?
    UNION SELECT manager_id FROM projects WHERE org_id=? AND id=? AND manager_id IS NOT NULL
    UNION SELECT employee_id FROM project_assignments WHERE org_id=? AND project_id=? AND unassigned_at IS NULL`,
    orgId,projectId,orgId,projectId,orgId,projectId);
  return rows.map(row=>row.employee_id);
}

export async function projectStaffAvailable(db: Db, actor: Actor, project: AccessibleProject, employee: string) {
  if (project.can_administer) return requireProjectPlanEmployee(db, actor, employee);
  if (project.manager_id !== actor.id) return fail(403, "Project manager access is required.");
  if (!await one(db, `SELECT e.id FROM employees e WHERE e.org_id=? AND e.id=? AND e.role<>'guest'
      AND e.status='Active' AND e.employment_status<>'Ended'
      AND (e.id=? OR e.manager_id=? OR (e.department_id IS NOT NULL AND e.department_id=?)
      OR EXISTS(SELECT 1 FROM staff_unit_memberships m WHERE m.org_id=e.org_id AND m.employee_id=e.id AND m.unit_id=?))`,
      actor.org_id,employee,actor.id,actor.id,project.department_id,project.team_id)) {
    return fail(403, "Choose an employee from the project department, assigned team or your direct reports.");
  }
}

export async function assignProjectStaff(db: Db, actor: Actor, project: AccessibleProject, raw: unknown) {
  if (!Array.isArray(raw) || raw.length>100) return fail(400, "Choose up to 100 project employees.");
  const requested = new Set(raw.map(item => str(item, "project employee", 80)));
  const existing = await all<ProjectAssignment>(db, `SELECT id,employee_id FROM project_assignments
    WHERE org_id=? AND project_id=? AND unassigned_at IS NULL`,actor.org_id,project.id);
  const active = new Set(existing.map(row=>row.employee_id));
  const removed = existing.filter(row=>!requested.has(row.employee_id));
  const added = [...requested].filter(employee=>!active.has(employee));
  for (const employee of added) await projectStaffAvailable(db,actor,project,employee);
  const current = now();
  for (const row of removed) await run(db, `UPDATE project_assignments SET unassigned_at=?,unassigned_by=?
    WHERE org_id=? AND id=? AND unassigned_at IS NULL`,current,actor.id,actor.org_id,row.id);
  for (const employee of added) await run(db, `INSERT INTO project_assignments(id,org_id,project_id,employee_id,assigned_by,assigned_at)
    VALUES(?,?,?,?,?,?)`,id(),actor.org_id,project.id,employee,actor.id,current);
  await projectNotifications(db,actor.org_id,added.filter(employee=>employee!==actor.id),"Project assigned",project.name,project.id);
  await projectNotifications(db,actor.org_id,removed.map(row=>row.employee_id).filter(employee=>employee!==actor.id),
    "Project assignment ended","Your assignment to "+project.name+" ended.",project.id);
  return {added,removed};
}

type Deadline = {org_id:string;project_id:string;name:string;employee_id:string;kind:string;item_key:string;due_on:string};

export async function maintainProjects(db: Db, at = now()) {
  if (!projectLifecycleEnabled()) return 0;
  const expires=performance.now()+8000;
  const edge = new Date(Date.parse(at)+172800000).toISOString();
  const candidates=await all<Deadline>(db, `
    WITH active AS (
      SELECT * FROM projects WHERE status IN ('Active','On hold','Planned')
    ), people AS (
      SELECT p.org_id,p.id AS project_id,p.owner_id AS employee_id FROM active p
      UNION SELECT p.org_id,p.id,p.manager_id FROM active p WHERE p.manager_id IS NOT NULL
      UNION SELECT a.org_id,a.project_id,a.employee_id FROM project_assignments a
        JOIN active p ON p.id=a.project_id AND p.org_id=a.org_id WHERE a.unassigned_at IS NULL
    ), due AS (
      SELECT p.org_id,p.id AS project_id,p.name,'project' AS item_key,p.due_on,m.employee_id
        FROM active p JOIN people m ON m.project_id=p.id AND m.org_id=p.org_id WHERE p.due_on IS NOT NULL
      UNION ALL SELECT p.org_id,p.id,p.name||' · '||m.title,'milestone:'||m.id,m.due_on,m.assignee_id
        FROM active p JOIN project_milestones m ON m.project_id=p.id JOIN people e ON e.project_id=p.id AND e.employee_id=m.assignee_id
        WHERE m.completed_at IS NULL
      UNION ALL SELECT p.org_id,p.id,p.name||' · '||d.title,'deliverable:'||d.id,d.due_on,d.assignee_id
        FROM active p JOIN project_deliverables d ON d.project_id=p.id AND d.org_id=p.org_id
        JOIN people e ON e.project_id=p.id AND e.employee_id=d.assignee_id
        WHERE d.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM project_deliverable_versions v
          WHERE v.org_id=d.org_id AND v.deliverable_id=d.id AND v.status='Approved')
    ), local AS (
      SELECT d.*,CASE WHEN d.due_on<to_char(?::timestamptz AT TIME ZONE e.time_zone,'YYYY-MM-DD') THEN 'Overdue' ELSE 'Due soon' END AS kind
        FROM due d JOIN employees e ON e.id=d.employee_id AND e.org_id=d.org_id
        WHERE e.status='Active' AND e.employment_status<>'Ended' AND e.role<>'guest'
        AND d.due_on<=to_char(?::timestamptz AT TIME ZONE e.time_zone,'YYYY-MM-DD')
    ) SELECT l.* FROM local l WHERE NOT EXISTS(SELECT 1 FROM project_deadline_notices n
       WHERE n.project_id=l.project_id AND n.kind=l.kind AND n.item_key=l.item_key AND n.due_on=l.due_on AND n.employee_id=l.employee_id)
      ORDER BY l.due_on,l.project_id,l.employee_id LIMIT 250`,at,edge);
  let sent=0;
  for (const entry of candidates) {
    if(performance.now()>=expires)break;
    sent+=await db.transaction(async tx=>{
      const project=await one<{due_on:string|null}>(tx,`SELECT due_on FROM projects WHERE id=? AND org_id=? AND status IN ('Active','On hold','Planned') FOR UPDATE`,
        entry.project_id,entry.org_id);
      if(!project||!(await projectPeople(tx,entry.org_id,entry.project_id)).includes(entry.employee_id))return 0;
      if(entry.item_key==="project"){
        if(project.due_on!==entry.due_on)return 0;
      }else{
        const [kind,item]=entry.item_key.split(":");
        const open=kind==="milestone"
          ? await one(tx,"SELECT id FROM project_milestones WHERE id=? AND project_id=? AND assignee_id=? AND due_on=? AND completed_at IS NULL",
            item,entry.project_id,entry.employee_id,entry.due_on)
          : await one(tx,`SELECT d.id FROM project_deliverables d WHERE d.org_id=? AND d.id=? AND d.project_id=? AND d.assignee_id=?
            AND d.due_on=? AND d.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM project_deliverable_versions v
              WHERE v.org_id=d.org_id AND v.deliverable_id=d.id AND v.status='Approved')`,entry.org_id,item,entry.project_id,entry.employee_id,entry.due_on);
        if(!open)return 0;
      }
      const stored=await run(tx,`INSERT INTO project_deadline_notices(org_id,project_id,item_key,kind,due_on,employee_id,created_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,entry.org_id,entry.project_id,entry.item_key,entry.kind,entry.due_on,entry.employee_id,at);
      if(stored.count)await projectNotifications(tx,entry.org_id,[entry.employee_id],entry.kind==="Overdue"?"Project work overdue":"Upcoming project deadline",
        entry.name+" · "+entry.due_on,entry.project_id);
      return stored.count;
    });
  }
  return sent;
}
