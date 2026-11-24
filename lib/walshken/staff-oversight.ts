import { all, one, run, id, now, digest, orgId, date, integer, str, json, requireSuper, type Actor, type Db } from "./server";
import { localDate } from "./work";
import { workDataset, workforceEnabled } from "./workforce";
import { taskDataset, tasksEnabled } from "./tasks";
import { payrollDataset, payrollEnabled } from "./payroll-access";
import { holidayDataset, holidaysEnabled } from "./holiday-access";
import { documentsEnabled } from "./document-access";
import { staffReadinessEnabled } from "./staff-permissions";

export async function recordSignInFailure(db: Db, account: string, status: number) {
  if (!staffReadinessEnabled() || ![401,429].includes(status)) return;
  const fingerprint = await digest(`staff-auth:${account}`);
  const at = now();
  const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  await db.transaction(async tx => {
    await one(tx,"SELECT id FROM organizations WHERE id=? FOR UPDATE",orgId);
    const employee = await one<{id:string}>(tx,"SELECT id FROM employees WHERE org_id=? AND email=?",orgId,account);
    const action = status === 429 ? "Sign-in rate limited" : "Sign-in failed";
    const recent = await one<{n:number}>(tx,`SELECT count(*)::int AS n FROM staff_security_events
      WHERE org_id=? AND fingerprint=? AND created_at>=? AND action=?`,orgId,fingerprint,cutoff,action);
    if (status === 429 && recent?.n) return;
    const record = (event: string) => run(tx,`INSERT INTO staff_security_events(id,org_id,employee_id,fingerprint,action,created_at)
      SELECT ?,id,?,?,?,? FROM organizations WHERE id=?`,id(),employee?.id??null,fingerprint,event,at,orgId);
    await record(action);
    if (recent?.n === 4 && status === 401) await record("Repeated sign-in failures");
  });
}

export async function auditExplorer(db: Db, actor: Actor, params: URLSearchParams) {
  requireSuper(actor);
  const from = date(params.get("from"),"start date",false) ?? "";
  const to = date(params.get("to"),"end date",false) ?? "";
  const query = str(params.get("q"),"search text",100,false);
  const category = str(params.get("category"),"category",30,false);
  const page = integer(params.get("page") ?? "1","page",1,1000);
  const sources = [
    { type:"General", sql:`SELECT id,actor_id,action,entity,target_id,created_at FROM audit WHERE org_id=?`, args:[actor.org_id] },
    { type:"Security", sql:`SELECT id,employee_id AS actor_id,action,'Sign-in' AS entity,employee_id AS target_id,created_at FROM staff_security_events WHERE org_id=?`, args:[actor.org_id] },
    { type:"Calls", sql:`SELECT m.id,NULL::text AS actor_id,m.event AS action,'Meeting' AS entity,m.meeting_id AS target_id,m.created_at FROM meeting_events m JOIN meetings c ON c.id=m.meeting_id WHERE c.org_id=?`,args:[actor.org_id] },
    ...(tasksEnabled() ? [{ type:"Tasks", sql:`SELECT t.id,t.actor_id,t.action,'Task' AS entity,t.task_id AS target_id,t.created_at FROM task_events t JOIN tasks p ON p.id=t.task_id WHERE t.org_id=? AND p.release_stage=?`,args:[actor.org_id,taskDataset()] }] : []),
    ...(documentsEnabled() ? [{ type:"Documents",sql:`SELECT id,actor_id,action,'Document' AS entity,COALESCE(document_id,folder_id) AS target_id,created_at FROM doc_events WHERE org_id=?`,args:[actor.org_id] }] : []),
    ...(workforceEnabled() ? [{ type:"Attendance",sql:`SELECT id,actor_id,action,entity,target_id,created_at FROM work_events WHERE org_id=? AND release_stage=?`,args:[actor.org_id,workDataset()] }] : []),
    ...(payrollEnabled() ? [{ type:"Payroll",sql:`SELECT id,actor_id,action,entity,target_id,created_at FROM payroll_events WHERE org_id=? AND release_stage=?`,args:[actor.org_id,payrollDataset()] }] : []),
    ...(holidaysEnabled() ? [{ type:"Compliance",sql:`SELECT id,actor_id,action,entity,target_id,created_at FROM holiday_audit WHERE org_id=? AND release_stage=?`,args:[actor.org_id,holidayDataset()] }] : []),
  ];
  const selected = category ? sources.filter(source=>source.type===category) : sources;
  const rows = selected.length ? await all(db,`
    WITH events AS (${selected.map(source=>`SELECT x.*, '${source.type}' AS category FROM (${source.sql}) x`).join(" UNION ALL ")})
    SELECT a.*,e.name FROM events a LEFT JOIN employees e ON e.id=a.actor_id AND e.org_id=?
    WHERE (?='' OR strpos(lower(concat_ws(' ',a.action,a.entity,a.target_id,e.name)),lower(?))>0)
    AND (?='' OR left(a.created_at,10)>=?) AND (?='' OR left(a.created_at,10)<=?)
    ORDER BY a.created_at DESC,a.category,a.id LIMIT 51 OFFSET ?`,...selected.flatMap(source=>source.args),actor.org_id,query,query,from,from,to,to,(page-1)*50) : [];
  return json({rows:rows.slice(0,50),auditFilters:{from,to,query,category,categories:sources.map(source=>source.type),page,next:rows.length>50}});
}

export async function managementOverview(db: Db, actor: Actor) {
  requireSuper(actor);
  const at=now(), day=localDate(at,actor.time_zone), start=day.slice(0,7)+"-01";
  const [people,attendance,work,security,payroll,nextPay,joiners,anniversaries,securityEvents] = await Promise.all([
    one(db,`SELECT count(*)::int AS employees,
      count(*) FILTER (WHERE status='Active' AND employment_status='Active')::int AS active,
      count(*) FILTER (WHERE status<>'Active' OR employment_status='Ended')::int AS inactive,
      count(*) FILTER (WHERE status='Active' AND employment_status='On leave')::int AS on_leave,
      count(*) FILTER (WHERE status='Active' AND COALESCE(jurisdiction,'')='')::int AS missing_jurisdiction
      FROM employees WHERE org_id=? AND role<>'guest'`,actor.org_id),
    workforceEnabled() ? one(db,`SELECT
      (SELECT count(DISTINCT a.employee_id)::int FROM attendance a JOIN employees e ON e.id=a.employee_id WHERE a.org_id=? AND a.release_stage=? AND a.ends_at IS NULL AND e.status='Active') AS clocked_in,
      (SELECT count(*)::int FROM breaks b JOIN attendance a ON a.id=b.attendance_id WHERE a.org_id=? AND a.release_stage=? AND a.ends_at IS NULL AND b.ends_at IS NULL AND b.voided_at IS NULL) AS on_break,
      (SELECT count(*)::int FROM attendance_absences WHERE org_id=? AND release_stage=? AND status='No show' AND left(recorded_at,10)=?) AS absences,
      (SELECT count(*)::int FROM corrections c JOIN employees e ON e.id=c.employee_id WHERE e.org_id=? AND c.release_stage=? AND c.status='Pending') AS corrections,
      (SELECT count(*)::int FROM timesheets WHERE org_id=? AND release_stage=? AND status IN ('Draft','Returned')) AS missing_timesheets,
      (SELECT count(*)::int FROM timesheets WHERE org_id=? AND release_stage=? AND status='Submitted') AS submitted_timesheets,
      (SELECT count(*)::int FROM leave_requests WHERE org_id=? AND release_stage=? AND status='Pending') AS leave_requests`,
      actor.org_id,workDataset(),actor.org_id,workDataset(),actor.org_id,workDataset(),day,actor.org_id,workDataset(),actor.org_id,workDataset(),actor.org_id,workDataset(),actor.org_id,workDataset()) : null,
    tasksEnabled() ? one(db,`SELECT count(*) FILTER (WHERE status NOT IN ('Completed','Cancelled'))::int AS open_tasks,
      count(*) FILTER (WHERE status='Completed')::int AS completed_tasks,
      count(*) FILTER (WHERE status NOT IN ('Completed','Cancelled') AND due_date<?)::int AS overdue_tasks,
      count(*) FILTER (WHERE status='Waiting for Review')::int AS tasks_to_review,
      (SELECT count(*)::int FROM projects WHERE org_id=? AND lower(status)='active') AS active_projects
      FROM tasks WHERE org_id=? AND release_stage=?`,day,actor.org_id,actor.org_id,taskDataset()) : null,
    one(db,`SELECT
      (SELECT count(*)::int FROM sessions s JOIN employees e ON e.id=s.employee_id WHERE e.org_id=? AND e.status='Active' AND e.employment_status<>'Ended' AND s.ended_at IS NULL AND s.expires_at>?) AS sessions,
      (SELECT count(*)::int FROM audit WHERE org_id=? AND action='Signed in' AND left(created_at,10)=?) AS sign_ins,
      (SELECT count(*)::int FROM audit WHERE org_id=? AND (entity='staff permission' OR action='Role changed') AND left(created_at,10)>=?) AS permission_changes,
      (SELECT count(*)::int FROM staff_security_events WHERE org_id=? AND action='Sign-in failed' AND left(created_at,10)=?) AS failed,
      (SELECT count(*)::int FROM staff_security_events WHERE org_id=? AND action='Repeated sign-in failures' AND left(created_at,10)>=?) AS alerts`,
      actor.org_id,at,actor.org_id,day,actor.org_id,start,actor.org_id,day,actor.org_id,start),
    payrollEnabled() ? all(db,`SELECT p.currency,p.minor_unit,SUM(p.gross_cents)::text AS gross,
      SUM(p.regular_seconds)::text AS regular,SUM(p.overtime_seconds)::text AS overtime
      FROM payroll p JOIN payroll_periods r ON r.id=p.period_id
      WHERE p.org_id=? AND p.release_stage=? AND r.pay_date>=? AND p.status NOT IN ('Cancelled','Finalized')
      GROUP BY p.currency,p.minor_unit ORDER BY p.currency`,actor.org_id,payrollDataset(),start) : [],
    payrollEnabled() ? all(db,`SELECT id,label,pay_date,status FROM payroll_periods WHERE org_id=? AND release_stage=? AND pay_date>=? AND status<>'Cancelled'
      ORDER BY pay_date LIMIT 8`,actor.org_id,payrollDataset(),day) : [],
    all(db,`SELECT id,name,hire_date FROM employees WHERE org_id=? AND role<>'guest' AND hire_date IS NOT NULL
      AND hire_date<>'' ORDER BY hire_date DESC LIMIT 6`,actor.org_id),
    all(db,`SELECT id,name,hire_date FROM employees WHERE org_id=? AND role<>'guest' AND status='Active'
      AND hire_date IS NOT NULL AND hire_date<>'' ORDER BY CASE WHEN substr(hire_date,6,5)>=substr(?,6,5) THEN 0 ELSE 1 END,substr(hire_date,6,5) LIMIT 6`,actor.org_id,day),
    all(db,`SELECT a.id,e.name,a.action,a.created_at FROM audit a LEFT JOIN employees e ON e.id=a.actor_id
      WHERE a.org_id=? AND (a.action='Signed in' OR a.entity='staff permission' OR a.action='Role changed') ORDER BY a.created_at DESC LIMIT 8`,actor.org_id),
  ]);
  const files = documentsEnabled() ? await all(db,`SELECT d.id,e.name,d.action,d.created_at FROM doc_events d JOIN employees e ON e.id=d.actor_id
    WHERE d.org_id=? ORDER BY d.created_at DESC LIMIT 8`,actor.org_id) : [];
  return {day,people,attendance,work,security,payroll,nextPay,joiners,anniversaries,securityEvents,files};
}
