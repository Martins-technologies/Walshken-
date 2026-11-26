import { accessibleProject, activeProjectAssignment, projectOrganizationEditor, projectOwnerEditor, projectScope, requireProjectPlanEmployee } from "./project-authority";
import {
  assignProjectStaff, editableProjectStatus, maintainProjects as sendProjectDeadlines, openProject, projectNotifications, projectPeople, projectPriorities, projectRevision, recordProjectEvent,
  type AccessibleProject,
} from "./project-work";
import { all, audit, canSuper, date, fail, id, integer, json, now, one, pick, requireStaff, run, str, type Actor, type Db } from "./server";
import { taskDataset } from "./tasks";
import { staffReadinessEnabled, type StaffPermission } from "./staff-permissions";
import { cleanupProjectDeliverables, projectDeliverableAction } from "./project-deliverables";

export { projectLifecycleEnabled } from "./project-authority";
export async function maintainProjects(db: Db) {
  const sent=await sendProjectDeadlines(db);
  await cleanupProjectDeliverables(db);
  return sent;
}
const statuses = ["Planned", "Active", "On hold", "In review", "Completed", "Cancelled", "Archived"] as const;

export async function projectsView(db: Db, actor: Actor, params: URLSearchParams) {
  requireStaff(actor);
  const query = str(params.get("q"), "search", 100, false);
  const target = str(params.get("project"), "project", 80, false);
  const status = str(params.get("status"), "status", 24, false);
  if (status) pick(status, statuses, "project status");
  const exportReport = params.get("export") === "1";
  const page = integer(params.get("page") ?? 1, "page", 1, 10000);
  const order = pick(params.get("order") ?? "Recent", ["Recent", "Deadline", "Name"], "sort order");
  const sorts = { Recent: "p.created_at DESC", Deadline: "p.due_on ASC NULLS LAST", Name: "lower(p.name)" };
  const stage = taskDataset();
  const manage = projectScope(actor,"manage",stage), review = projectScope(actor,"review",stage);
  const read = projectScope(actor,"read",stage), exports = projectScope(actor,"export",stage);
  const administer = projectOrganizationEditor(actor), projectEditor=projectOwnerEditor(actor), ownAssignment=activeProjectAssignment(actor.id);
  if (exportReport && !await one(db,`SELECT p.id FROM projects p JOIN employees owner ON owner.id=p.owner_id AND owner.org_id=p.org_id
      WHERE p.org_id=? AND (${read.sql}) AND (${exports.sql}) LIMIT 1`,actor.org_id,...read.args,...exports.args)
      && !canSuper(actor)) return fail(403,"Project reporting export is outside your authority.");
  const exportScope=exportReport?exports:{sql:"1=1",args:[]};
  const rows = await all(db, `
    SELECT p.*, owner.name AS owner, manager.name AS manager, d.name AS department, team.name AS team,
      count(*) OVER()::int AS total_rows,
      (SELECT count(*)::int FROM project_milestones m WHERE m.project_id=p.id) AS milestone_count,
      (SELECT count(*)::int FROM project_milestones m WHERE m.project_id=p.id AND m.completed_at IS NOT NULL) AS milestones_done,
      (SELECT count(*)::int FROM project_milestones m WHERE m.project_id=p.id AND m.completed_at IS NULL AND m.due_on<?) AS milestones_overdue,
      CASE WHEN p.due_on<? AND p.status IN ('Planned','Active','On hold') THEN 1 ELSE 0 END AS overdue,
      CASE WHEN (${manage.sql}) THEN 1 ELSE 0 END AS can_manage,
      CASE WHEN (${projectEditor.sql}) THEN 1 ELSE 0 END AS can_administer,
      CASE WHEN (${review.sql}) AND p.submitted_by<>? AND p.owner_id<>? AND COALESCE(p.manager_id,'')<>? THEN 1 ELSE 0 END AS can_review,
      CASE WHEN (${exports.sql}) THEN 1 ELSE 0 END AS can_export,
      CASE WHEN ${ownAssignment.sql} OR p.owner_id=? THEN 1 ELSE 0 END AS is_assigned,
      (SELECT count(*)::int FROM tasks t WHERE t.project_id=p.id AND t.org_id=p.org_id AND t.release_stage=?
        AND ((${manage.sql}) OR p.owner_id=? OR t.employee_id=?)) AS tasks,
      (SELECT count(*)::int FROM tasks t WHERE t.project_id=p.id AND t.org_id=p.org_id AND t.release_stage=? AND t.status='Completed'
        AND ((${manage.sql}) OR p.owner_id=? OR t.employee_id=?)) AS tasks_done
    FROM projects p JOIN employees owner ON owner.id=p.owner_id AND owner.org_id=p.org_id
    LEFT JOIN employees manager ON manager.id=p.manager_id AND manager.org_id=p.org_id
    LEFT JOIN units d ON d.id=p.department_id AND d.org_id=p.org_id
    LEFT JOIN units team ON team.id=p.team_id AND team.org_id=p.org_id
    WHERE p.org_id=? AND (${read.sql}) AND (${exportScope.sql})
      AND (?='' OR p.id=?) AND (?='' OR p.status=?) AND (?='' OR strpos(lower(concat_ws(' ',p.name,p.description,owner.name,manager.name)),lower(?))>0)
    ORDER BY ${sorts[order]},p.id LIMIT ? OFFSET ?`,
    now().slice(0,10),now().slice(0,10),...manage.args,...projectEditor.args,...review.args,actor.id,actor.id,actor.id,...exports.args,...ownAssignment.args,actor.id,
    stage,...manage.args,actor.id,actor.id,stage,...manage.args,actor.id,actor.id,
    actor.org_id,...read.args,...exportScope.args,target,target,status,status,query,query,exportReport?1001:25,exportReport?0:(page-1)*25);
  if(exportReport){
    if(rows.length>1000)return fail(400,"Filter project status or name to export up to 1,000 records.");
    const cells=[["Project","Owner","Manager","Department","Team","Priority","Status","Start","Deadline","Milestones","Completed milestones","Overdue milestones","Visible tasks","Completed visible tasks"],
      ...rows.map(row=>[row.name,row.owner,row.manager,row.department,row.team,row.priority,row.status,row.starts_on,row.due_on,row.milestone_count,row.milestones_done,row.milestones_overdue,row.tasks,row.tasks_done])];
    const quote=(value:unknown)=>'"'+String(value??"").replace(/^\s*[=+@-]|^[\t\r\n]/,"'$&").replaceAll('"','""')+'"';
    await audit(db,actor,"Project report exported","project report",String(rows.length)).run();
    return new Response("\uFEFF"+cells.map(row=>row.map(quote).join(",")).join("\r\n"),{headers:{
      "Content-Type":"text/csv; charset=utf-8","Content-Disposition":'attachment; filename="project-report.csv"',
      "Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"
    }});
  }
  const visible = rows.map(row=>row.id);
  const managedIds=rows.filter(row=>Number(row.can_manage)===1).map(row=>row.id);
  const [milestones, owners, units, assignments, deliverables, events, eligible, workload] = await Promise.all([
    visible.length ? all(db, `SELECT m.*, e.name AS assignee FROM project_milestones m JOIN projects p ON p.id=m.project_id
      LEFT JOIN employees e ON e.id=m.assignee_id AND e.org_id=p.org_id WHERE p.org_id=? AND p.id=ANY(?::text[]) ORDER BY m.due_on,m.id`,actor.org_id,visible) : [],
    all(db, `SELECT owner.id,owner.name,owner.employee_no FROM employees owner WHERE owner.org_id=? AND owner.role<>'guest'
      AND owner.status='Active' AND owner.employment_status<>'Ended' AND (${administer.sql}) ORDER BY owner.name`,actor.org_id,...administer.args),
    all(db,`SELECT id,name,kind FROM units WHERE org_id=? AND kind IN ('Department','Team') AND
      (?=1 OR EXISTS (SELECT 1 FROM employees owner WHERE owner.org_id=units.org_id AND owner.role<>'guest'
        AND (${administer.sql}) AND (owner.department_id=units.id OR EXISTS (SELECT 1 FROM staff_unit_memberships m
          WHERE m.org_id=owner.org_id AND m.employee_id=owner.id AND m.unit_id=units.id)))) ORDER BY name`,actor.org_id,canSuper(actor)?1:0,...administer.args),
    visible.length ? all(db,`SELECT p.*,e.name,CASE WHEN p.project_id=ANY(?::text[]) THEN e.employee_no END AS employee_no
      FROM project_assignments p JOIN employees e ON e.id=p.employee_id AND e.org_id=p.org_id
      WHERE p.org_id=? AND p.project_id=ANY(?::text[]) AND (p.unassigned_at IS NULL OR p.employee_id=? OR p.project_id=ANY(?::text[]))
      ORDER BY p.assigned_at DESC, p.id`,managedIds,actor.org_id,visible,actor.id,managedIds) : [],
    visible.length ? all(db,`SELECT d.*,e.name AS assignee,v.id AS version_id,v.filename,v.version,v.status AS file_status,v.review_note,v.uploaded_by
      FROM project_deliverables d LEFT JOIN employees e ON e.id=d.assignee_id AND e.org_id=d.org_id
      LEFT JOIN LATERAL (SELECT * FROM project_deliverable_versions v WHERE v.org_id=d.org_id AND v.deliverable_id=d.id
        ORDER BY v.version DESC LIMIT 1) v ON true
      WHERE d.org_id=? AND d.project_id=ANY(?::text[]) AND d.archived_at IS NULL ORDER BY d.due_on,d.id`,actor.org_id,visible) : [],
    visible.length ? all(db,`SELECT a.id,a.action,a.target_id AS project_id,a.created_at,e.name AS actor FROM audit a
      LEFT JOIN employees e ON e.id=a.actor_id AND e.org_id=a.org_id
      WHERE a.org_id=? AND a.entity='project' AND a.target_id=ANY(?::text[]) ORDER BY a.created_at DESC,a.id DESC LIMIT 250`,actor.org_id,visible) : [],
    visible.length ? all(db,`SELECT p.id AS project_id,e.id AS employee_id,e.name,e.employee_no FROM projects p JOIN employees e ON e.org_id=p.org_id
      WHERE p.org_id=? AND p.id=ANY(?::text[]) AND p.manager_id=? AND e.status='Active' AND e.employment_status<>'Ended' AND e.role<>'guest'
        AND (e.id=? OR e.manager_id=? OR (e.department_id IS NOT NULL AND e.department_id=p.department_id)
        OR EXISTS(SELECT 1 FROM staff_unit_memberships m WHERE m.org_id=e.org_id AND m.employee_id=e.id AND m.unit_id=p.team_id))
      ORDER BY e.name`,actor.org_id,visible,actor.id,actor.id,actor.id) : [],
    visible.length ? all(db,`SELECT w.project_id,w.employee_id,e.name,sum(w.tasks)::int AS tasks,sum(w.tasks_done)::int AS tasks_done,
      sum(w.milestones)::int AS milestones,sum(w.milestones_done)::int AS milestones_done FROM (
        SELECT t.project_id,t.employee_id,count(*) AS tasks,count(*) FILTER (WHERE t.status='Completed') AS tasks_done,0 AS milestones,0 AS milestones_done
          FROM tasks t WHERE t.org_id=? AND t.release_stage=? AND t.project_id=ANY(?::text[]) AND t.status<>'Cancelled'
          AND (t.employee_id=? OR t.project_id=ANY(?::text[])) GROUP BY t.project_id,t.employee_id
        UNION ALL SELECT m.project_id,m.assignee_id,0,0,count(*),count(*) FILTER (WHERE m.completed_at IS NOT NULL)
          FROM project_milestones m JOIN projects p ON p.id=m.project_id WHERE p.org_id=? AND m.project_id=ANY(?::text[])
          AND m.assignee_id IS NOT NULL AND (m.assignee_id=? OR m.project_id=ANY(?::text[])) GROUP BY m.project_id,m.assignee_id
      ) w JOIN employees e ON e.org_id=? AND e.id=w.employee_id GROUP BY w.project_id,w.employee_id,e.name ORDER BY e.name`,
      actor.org_id,stage,visible,actor.id,managedIds,actor.org_id,visible,actor.id,managedIds,actor.org_id) : [],
  ]);
  return json({managedProjects:true,rows,milestones,owners,units,assignments,deliverables,events,eligible,workload,
    viewer:actor.id,canCreate:owners.length>0,canExport:canSuper(actor)||rows.some(row=>Number(row.can_export)===1),
    query,status,order,page,target,total:Number(rows[0]?.total_rows??0)});
}

async function planUnit(db: Db, actor: Actor, target: string, kind: "Department"|"Team") {
  if (!target) return null;
  if(!await one(db,"SELECT id FROM units WHERE org_id=? AND id=? AND kind=?",actor.org_id,target,kind)) {
    return fail(400,`Choose an available ${kind.toLowerCase()}.`);
  }
  if(canSuper(actor))return target;
  const editor=projectOrganizationEditor(actor);
  const member=kind==="Department"?"owner.department_id=?":`EXISTS(SELECT 1 FROM staff_unit_memberships t
    WHERE t.unit_id=? AND t.org_id=owner.org_id AND t.employee_id=owner.id)`;
  if(!await one(db,`SELECT owner.id FROM employees owner WHERE owner.org_id=? AND owner.role<>'guest'
    AND (${member}) AND (${editor.sql}) LIMIT 1`,actor.org_id,target,...editor.args)) {
    return fail(403,`The selected ${kind.toLowerCase()} is outside your project administration scope.`);
  }
  return target;
}

async function plan(db: Db, actor: Actor, data: Record<string, unknown>, current?: AccessibleProject) {
  const name=str(data.name,"project name",120),description=str(data.description,"description",2000,false);
  const start=date(data.start,"start date",false),due=date(data.due,"deadline",false);
  if(start&&due&&start>due)return fail(400,"The deadline must be on or after the start date.");
  const ownerId=str(data.owner??current?.owner_id??actor.id,"project owner",80);
  const managerId=str(data.manager??current?.manager_id??"","project manager",80,false)||null;
  const teamId=str(data.team??current?.team_id??"","team",80,false)||null;
  let departmentId=data.department!==undefined?str(data.department,"department",80,false)||null:current?.department_id;
  if(!current||current.can_administer){
    const owner=await requireProjectPlanEmployee(db,actor,ownerId);
    if(managerId)await requireProjectPlanEmployee(db,actor,managerId);
    if(departmentId===undefined)departmentId=owner.department_id;
    if(data.department!==undefined)departmentId=await planUnit(db,actor,departmentId??"","Department");
    if(data.team!==undefined)await planUnit(db,actor,teamId??"","Team");
  }else if(ownerId!==current.owner_id||managerId!==current.manager_id||teamId!==current.team_id||departmentId!==current.department_id){
    return fail(403,"Only a scoped administrator can move project ownership or organizational scope.");
  }
  const status=pick(data.status??current?.status??"Active",current?editableProjectStatus:["Planned","Active"] as const,"project status");
  const priority=pick(data.priority??current?.priority??"Normal",projectPriorities,"priority");
  return {name,description,start,due,ownerId,managerId,teamId,departmentId:departmentId??null,status,priority};
}

async function milestoneAction(db: Db, actor: Actor, project: AccessibleProject, action: string, data: Record<string,unknown>) {
  openProject(project);
  const staff=await projectPeople(db,actor.org_id,project.id);
  const key=action==="milestone-add"?id():str(data.milestone,"milestone",80);
  if(action==="milestone-complete"){
    const milestone=await one<{assignee_id:string|null}>(db,
      "SELECT assignee_id FROM project_milestones WHERE project_id=? AND id=? AND completed_at IS NULL",project.id,key);
    if(!milestone)return fail(404,"Open milestone unavailable.");
    if(!project.can_manage&&(!staff.includes(actor.id)||milestone.assignee_id!==actor.id)) {
      return fail(403,"Only the assigned employee or an authorized project manager may complete this milestone.");
    }
    await run(db,`UPDATE project_milestones SET completed_at=?,completed_by=? WHERE project_id=? AND id=?`,now(),actor.id,project.id,key);
    return "Project milestone completed";
  }
  if(!project.can_manage)return fail(403,"Project management authority is required.");
  const due=date(data.due,"milestone deadline")!;
  if((project.starts_on&&due<project.starts_on)||(project.due_on&&due>project.due_on))return fail(400,"Choose a date inside the project schedule.");
  const title=str(data.title,"milestone title",120);
  const assigneeId=str(data.assignee,"milestone assignee",80,false)||null;
  if(assigneeId&&!staff.includes(assigneeId))return fail(403,"Assign milestones only to current project staff.");
  if(action==="milestone-add"){
    await run(db,`INSERT INTO project_milestones(id,project_id,title,due_on,created_by,created_at,assignee_id)
      VALUES(?,?,?,?,?,?,?)`,key,project.id,title,due,actor.id,now(),assigneeId);
    await projectNotifications(db,actor.org_id,(assigneeId?[assigneeId]:staff).filter(employee=>employee!==actor.id),"Project milestone added",project.name+" · "+title,project.id);
    return "Project milestone added";
  }
  const changed=await run(db,`UPDATE project_milestones SET title=?,due_on=?,assignee_id=?
    WHERE project_id=? AND id=? AND completed_at IS NULL`,title,due,assigneeId,project.id,key);
  if(!changed.count)return fail(404,"Open milestone unavailable.");
  return "Project milestone updated";
}

export async function projectAction(db: Db, actor: Actor, action: string, data: Record<string, unknown>) {
  requireStaff(actor);
  return db.transaction(async tx => {
    await one(tx,"SELECT id FROM organizations WHERE id=? FOR UPDATE",actor.org_id);
    if(action==="add"){
      const entry=await plan(tx,actor,data),projectId=id();
      await run(tx,`INSERT INTO projects(id,org_id,owner_id,manager_id,department_id,team_id,name,description,status,priority,starts_on,due_on)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,projectId,actor.org_id,entry.ownerId,entry.managerId,entry.departmentId,entry.teamId,entry.name,entry.description,entry.status,entry.priority,entry.start,entry.due);
      const project=await accessibleProject(tx,actor,projectId,taskDataset());
      const assigned=data.employees!==undefined?await assignProjectStaff(tx,actor,project,data.employees):{added:[] as string[]};
      await projectNotifications(tx,actor.org_id,[entry.ownerId,...(entry.managerId?[entry.managerId]:[])].filter(employee=>employee!==actor.id&&!assigned.added.includes(employee)),"Project responsibility assigned",entry.name,projectId);
      await audit(tx,actor,"Project created","project",projectId).run();
      return json({ok:true,id:projectId,message:"Project created."},201);
    }
    const target=str(data.id,"project",80),project=await accessibleProject(tx,actor,target,taskDataset(),true);
    projectRevision(project,data.revision);
    let event:string;
    if(action.startsWith("milestone-")){
      if(!["milestone-add","milestone-edit","milestone-complete"].includes(action))return fail(404,"Project action unavailable.");
      event=await milestoneAction(tx,actor,project,action,data);
    }else if(action.startsWith("deliverable-")){
      return projectDeliverableAction(tx,actor,project,action,data);
    }else if(action==="review"){
      if(!project.can_review)return fail(403,"Project review authority is required.");
      if(project.status!=="In review")return fail(409,"This project is not waiting for approval.");
      if(actor.id===project.submitted_by||actor.id===project.owner_id||actor.id===project.manager_id)return fail(403,"A different authorized reviewer must decide.");
      const decision=pick(data.decision,["Approve","Return"],"decision");
      const reason=str(data.reason,"review reason",500);
      if(decision==="Approve")await checkProjectCompletion(tx,actor,project);
      await run(tx,"UPDATE projects SET status=?,completed_at=? WHERE org_id=? AND id=?",decision==="Approve"?"Completed":"Active",decision==="Approve"?now():null,actor.org_id,target);
      event=`Project ${decision==="Approve"?"approved":"returned"} · ${reason}`;
      await projectNotifications(tx,actor.org_id,(await projectPeople(tx,actor.org_id,target)).filter(employee=>employee!==actor.id),
        decision==="Approve"?"Project approved":"Project returned for changes",project.name,target);
    }else{
      if(!project.can_manage)return fail(403,"Project management authority is required.");
      if(action==="edit"){
        openProject(project);
        const entry=await plan(tx,actor,data,project);
        const outOfRange=await one(tx,`SELECT id FROM project_milestones WHERE project_id=?
          AND ((?<>'' AND due_on<?) OR (?<>'' AND due_on>?))
          UNION ALL SELECT id FROM project_deliverables WHERE org_id=? AND project_id=? AND archived_at IS NULL
          AND ((?<>'' AND due_on<?) OR (?<>'' AND due_on>?)) LIMIT 1`,
          target,entry.start??"",entry.start??"",entry.due??"",entry.due??"",actor.org_id,target,entry.start??"",entry.start??"",entry.due??"",entry.due??"");
        if(outOfRange)return fail(409,"Move milestones and deliverables into the new date range first.");
        await run(tx,`UPDATE projects SET name=?,description=?,owner_id=?,manager_id=?,department_id=?,team_id=?,starts_on=?,due_on=?,status=?,priority=?
          WHERE org_id=? AND id=?`,entry.name,entry.description,entry.ownerId,entry.managerId,entry.departmentId,entry.teamId,entry.start,entry.due,entry.status,entry.priority,actor.org_id,target);
        const previous=new Set([project.owner_id,project.manager_id]);
        const next=new Set([entry.ownerId,entry.managerId]);
        await projectNotifications(tx,actor.org_id,[...next].filter((employee):employee is string=>Boolean(employee&&!previous.has(employee)&&employee!==actor.id)),
          "Project responsibility assigned",entry.name,target);
        await projectNotifications(tx,actor.org_id,[...previous].filter((employee):employee is string=>Boolean(employee&&!next.has(employee)&&employee!==actor.id)),
          "Project responsibility changed",entry.name,target);
        event=project.owner_id!==entry.ownerId||project.manager_id!==entry.managerId
          ? `Project responsibility changed · owner ${project.owner_id} → ${entry.ownerId} · manager ${project.manager_id??"none"} → ${entry.managerId??"none"}`
          : "Project plan updated";
      }else if(action==="assign"){
        openProject(project);
        const {added,removed}=await assignProjectStaff(tx,actor,project,data.employees);
        if(!added.length&&!removed.length)return json({ok:true,message:"The saved assignment is already current."});
        event=`Project assignments updated · ${added.length} added · ${removed.length} ended`;
      }else if(action==="submit"){
        if(project.status!=="Active")return fail(409,"Only an active project can be submitted.");
        await checkProjectCompletion(tx,actor,project);
        await run(tx,"UPDATE projects SET status='In review',submitted_by=?,submitted_at=? WHERE org_id=? AND id=?",actor.id,now(),actor.org_id,target);
        const reviewers=await all<Actor>(tx,`SELECT * FROM employees WHERE org_id=? AND role IN ('super_admin','admin','hr')
          AND status='Active' AND employment_status<>'Ended' AND id NOT IN (?,?,?)`,actor.org_id,actor.id,project.owner_id,project.manager_id??"");
        const allowed:string[]=[];
        for(const reviewer of reviewers){
          if(staffReadinessEnabled()&&reviewer.role!=="super_admin"){
            reviewer.permissions=await all<StaffPermission>(tx,`SELECT id,action,scope_type,scope_id,effect FROM staff_action_permissions
              WHERE org_id=? AND ((principal_type='employee' AND principal_id=?) OR (principal_type='role' AND principal_id=?)) AND action='projects.review'`,
              reviewer.org_id,reviewer.id,reviewer.role);
          }
          const scope=projectScope(reviewer,"review",taskDataset());
          if(await one(tx,`SELECT p.id FROM projects p JOIN employees owner ON owner.id=p.owner_id AND owner.org_id=p.org_id
            WHERE p.org_id=? AND p.id=? AND (${scope.sql})`,actor.org_id,target,...scope.args))allowed.push(reviewer.id);
        }
        await projectNotifications(tx,actor.org_id,allowed,"Project waiting for approval",project.name,target);
        event="Project submitted for approval";
      }else if(action==="cancel"||action==="archive"||action==="restore"){
        if(!project.can_administer)return fail(403,"A scoped administrator is required to close or restore a project.");
        if(action==="cancel"&&!editableProjectStatus.includes(project.status as typeof editableProjectStatus[number]))return fail(409,"Only open projects can be cancelled.");
        if(action==="archive"&&!["Completed","Cancelled"].includes(project.status))return fail(409,"Complete or cancel the project before archiving.");
        if(action==="restore"&&(project.status!=="Archived"||!project.archived_from))return fail(409,"This project cannot be restored.");
        const next=action==="cancel"?"Cancelled":action==="archive"?"Archived":project.archived_from;
        await run(tx,"UPDATE projects SET status=?,archived_from=? WHERE org_id=? AND id=?",next,action==="archive"?project.status:null,actor.org_id,target);
        event=action==="cancel"?"Project cancelled":action==="archive"?"Project archived":"Project restored";
      }else return fail(404,"Project action unavailable.");
    }
    await recordProjectEvent(tx,actor,target,event);
    return json({ok:true,message:"Project updated."});
  });
}

async function checkProjectCompletion(db: Db, actor: Actor, project: AccessibleProject) {
  if(await one(db,`SELECT id FROM project_milestones WHERE project_id=? AND completed_at IS NULL
    UNION ALL SELECT id FROM tasks WHERE org_id=? AND project_id=? AND release_stage=? AND status NOT IN ('Completed','Cancelled')
    UNION ALL SELECT d.id FROM project_deliverables d WHERE d.org_id=? AND d.project_id=? AND d.archived_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM project_deliverable_versions v WHERE v.deliverable_id=d.id AND v.org_id=d.org_id AND v.status='Approved') LIMIT 1`,
    project.id,actor.org_id,project.id,taskDataset(),actor.org_id,project.id)){
    return fail(409,"Complete project milestones, close open tasks and approve deliverables before submitting.");
  }
}
