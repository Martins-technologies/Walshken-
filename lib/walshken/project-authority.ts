import { permissionScope, staffReadinessEnabled, type StaffAction } from "./staff-permissions";
import { canSuper, fail, one, scope, type Actor, type Db } from "./server";

export const projectLifecycleEnabled = () => process.env.WALSHKEN_PROJECT_LIFECYCLE_ENABLED === "1";

export function activeProjectAssignment(actorId: string, projectAlias = "p") {
  return {
    sql: `EXISTS (SELECT 1 FROM project_assignments pa WHERE pa.project_id=${projectAlias}.id
      AND pa.org_id=${projectAlias}.org_id AND pa.employee_id=? AND pa.unassigned_at IS NULL)`,
    args: [actorId],
  };
}

export function projectScope(actor: Actor, operation: "read" | "manage" | "review" | "export", stage: string) {
  if (canSuper(actor)) return { sql: "1=1", args: [] };
  const scopedAdmin = defaultProjectAdmin(actor, true);
  const projectManager = "p.manager_id=?";
  const legacyProject = "p.manager_id IS NULL AND NOT EXISTS (SELECT 1 FROM project_assignments ph WHERE ph.project_id=p.id AND ph.org_id=p.org_id)";
  const readTasks = actor.role !== "hr" ? {
    sql: "EXISTS (SELECT 1 FROM tasks t WHERE t.project_id=p.id AND t.org_id=p.org_id AND t.release_stage=? AND t.employee_id=?)",
    args: [stage, actor.id],
  } : { sql: "1=0", args: [] };
  const member = activeProjectAssignment(actor.id);
  const editor = projectOwnerEditor(actor);
  const delegatedReviewer = staffReadinessEnabled()
    ? permissionScope(actor.permissions ?? [], "projects.review", "owner", {sql:"1=0",args:[]})
    : {sql:"1=0",args:[]};
  const fallbacks = {
    manage: { sql: `(${scopedAdmin.sql}) OR ${projectManager}`, args: [...scopedAdmin.args, actor.id] },
    read: {
      sql: `p.owner_id=? OR ${projectManager} OR ${member.sql} OR (${scopedAdmin.sql})
        OR (${legacyProject} AND ?=1 AND p.department_id=?) OR (${legacyProject} AND (${readTasks.sql})) OR (${editor.sql}) OR (${delegatedReviewer.sql})`,
      args: [actor.id, actor.id, ...member.args, ...scopedAdmin.args, actor.role==="hr"?0:1, actor.department_id, ...readTasks.args,...editor.args,...delegatedReviewer.args],
    },
    review: scopedAdmin,
    export: { sql: `(${scopedAdmin.sql}) OR ${projectManager}`, args: [...scopedAdmin.args, actor.id] },
  };
  const fallback = fallbacks[operation];
  return staffReadinessEnabled()
    ? permissionScope(actor.permissions ?? [], `projects.${operation}` as StaffAction, "owner", fallback)
    : fallback;
}

function defaultProjectAdmin(actor: Actor, existingProject: boolean) {
  if(actor.role!=="admin")return {sql:"1=0",args:[]};
  const allowed=scope(actor,"owner",true);
  if(!existingProject||!actor.department_id)return allowed;
  return {sql:`(${allowed.sql}) AND (p.department_id IS NULL OR p.department_id=?)`,args:[...allowed.args,actor.department_id]};
}

export function projectOwnerEditor(actor: Actor) {
  if(canSuper(actor))return {sql:"1=1",args:[]};
  const defaultScope=defaultProjectAdmin(actor,true);
  return staffReadinessEnabled()
    ? permissionScope(actor.permissions??[],"projects.manage","owner",defaultScope)
    : defaultScope;
}

export function projectOrganizationEditor(actor: Actor) {
  if (canSuper(actor)) return { sql: "1=1", args: [] };
  const defaultScope = actor.role === "admin" ? scope(actor, "owner", true) : { sql: "1=0", args: [] };
  return staffReadinessEnabled()
    ? permissionScope(actor.permissions ?? [], "projects.manage", "owner", defaultScope)
    : defaultScope;
}

export async function requireProjectPlanEmployee(db: Db, actor: Actor, target: string) {
  const allowed = projectOrganizationEditor(actor);
  const employee = await one<{ id: string; department_id: string|null }>(db, `
    SELECT owner.id,owner.department_id FROM employees owner
    WHERE owner.org_id=? AND owner.id=? AND owner.status='Active'
      AND owner.employment_status<>'Ended' AND owner.role<>'guest' AND (${allowed.sql})`,
    actor.org_id, target, ...allowed.args);
  if (!employee) return fail(403, "This staff member is outside your project administration scope.");
  return employee;
}

export async function accessibleProject(db: Db, actor: Actor, projectId: string, stage: string, lock = false) {
  const manage = projectScope(actor, "manage", stage), read = projectScope(actor, "read", stage);
  const editOwnership = projectOwnerEditor(actor), review = projectScope(actor, "review", stage);
  const row = await one<{
    id: string; name: string; owner_id: string; manager_id: string|null; department_id: string|null; team_id: string|null;
    status: string; priority: string; revision: number; starts_on: string|null; due_on: string|null;
    submitted_by: string|null; archived_from: string|null; can_manage: number; can_review: number; can_administer: number; is_assigned: number;
  }>(db, `
    SELECT p.*, CASE WHEN (${manage.sql}) THEN 1 ELSE 0 END AS can_manage,
      CASE WHEN (${review.sql}) THEN 1 ELSE 0 END AS can_review,
      CASE WHEN (${editOwnership.sql}) THEN 1 ELSE 0 END AS can_administer,
      CASE WHEN ${activeProjectAssignment(actor.id).sql} THEN 1 ELSE 0 END AS is_assigned
    FROM projects p JOIN employees owner ON owner.id=p.owner_id AND owner.org_id=p.org_id
    WHERE p.org_id=? AND p.id=? AND (${read.sql}) ${lock?"FOR UPDATE OF p":""}`,
    ...manage.args, ...review.args, ...editOwnership.args, actor.id, actor.org_id, projectId, ...read.args);
  if (!row) return fail(404, "Project unavailable.");
  return row;
}
