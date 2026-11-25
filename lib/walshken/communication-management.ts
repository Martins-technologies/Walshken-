import {
  communicationAccess, communicationGovernanceEnabled, communicationOversightActions, communicationScope,
  directoryVisibilityColumns, unitMember,
} from "./communication-access";
import { all, audit, canSuper, fail, id, json, now, one, pick, requireStaff, requireSuper, run, str, type Actor, type Db } from "./server";
import type { StaffAction } from "./staff-permissions";

const pageSize = 25;
const unitsFilter = (kind: "Department" | "Team") => `(?='' OR EXISTS(
  SELECT 1 FROM units unit WHERE unit.org_id=e.org_id AND unit.kind='${kind}' AND unit.id=? AND ${unitMember("e","unit")}
))`;

function requireOversight(actor: Actor) {
  requireStaff(actor);
  const access = communicationAccess(actor);
  if (!Object.values(access).some(Boolean)) return fail(403, "Communication oversight permission is required.");
  return access;
}

function pageNumber(input: unknown) {
  const page = Number(input ?? 1);
  if (!Number.isInteger(page) || page < 1 || page > 500) return fail(400,"Choose a valid page.");
  return page;
}

function conversationScope(actor: Actor, action: StaffAction) {
  const allowed = communicationScope(actor, action, "p");
  return {
    sql: `EXISTS(SELECT 1 FROM conversation_members member
      LEFT JOIN employees p ON p.id=member.employee_id AND p.org_id=c.org_id
      WHERE member.conversation_id=c.id
      HAVING BOOL_OR(p.status='Active' AND p.employment_status<>'Ended')
        AND BOOL_AND(p.id IS NOT NULL AND p.role<>'guest' AND COALESCE((${allowed.sql}),false)))`,
    args: allowed.args,
  };
}

function unitEditScope(actor: Actor) {
  if (canSuper(actor)) return {sql:"1=1",args:[]};
  const people = communicationScope(actor, "communication.visibility.team");
  const rules = actor.permissions?.filter(rule => rule.action === "communication.visibility.team") ?? [];
  const organization = rules.some(rule => rule.scope_type === "organization" && rule.effect === "allow");
  const departments = rules.filter(rule => rule.scope_type === "department" && rule.effect === "allow").map(rule => rule.scope_id);
  const deniedDepartments = rules.filter(rule => rule.scope_type === "department" && rule.effect === "deny").map(rule => rule.scope_id);
  return {
    sql: `(?=1 OR (u.kind='Department' AND u.id=ANY(?::text[])) OR EXISTS(SELECT 1 FROM employees e
        WHERE e.org_id=u.org_id AND e.role<>'guest' AND ${unitMember("e","u")}))
      AND NOT (u.kind='Department' AND u.id=ANY(?::text[]))
      AND NOT EXISTS(SELECT 1 FROM employees e WHERE e.org_id=u.org_id AND e.role<>'guest'
        AND ${unitMember("e","u")} AND NOT COALESCE((${people.sql}),false))`,
    args: [organization?1:0, departments, deniedDepartments, ...people.args],
  };
}

async function oversightUnits(db: Db, actor: Actor, access: ReturnType<typeof communicationAccess>) {
  const visible = Object.entries(communicationOversightActions)
    .filter(([key]) => access[key as keyof typeof communicationOversightActions])
    .map(([,action]) => communicationScope(actor,action));
  const canEdit = access.teamVisibility ? unitEditScope(actor) : {sql:"1=0",args:[]};
  const rows = await all<{id:string; name:string; kind:string; hidden:boolean; support:boolean; can_edit:boolean}>(db,
    `SELECT u.id,u.name,u.kind, h.unit_id IS NOT NULL AS hidden, s.unit_id IS NOT NULL AS support,
    (${canEdit.sql}) AS can_edit FROM units u
    LEFT JOIN staff_communication_hidden_units h ON h.org_id=u.org_id AND h.unit_id=u.id
    LEFT JOIN staff_communication_support_departments s ON s.org_id=u.org_id AND s.unit_id=u.id
    WHERE u.org_id=? AND u.kind IN('Department','Team') AND (
      ?=1 OR (${canEdit.sql}) OR EXISTS(SELECT 1 FROM employees e
      WHERE e.org_id=u.org_id AND e.role<>'guest' AND ${unitMember("e","u")} AND
        (${visible.length ? visible.map(scope => '('+scope.sql+')').join(' OR ') : '1=0'}))
    ) ORDER BY u.name,u.id`,
    ...canEdit.args, actor.org_id, access.policy?1:0, ...canEdit.args, ...visible.flatMap(scope => scope.args));
  return {departments:rows.filter(row => row.kind === "Department"), teams:rows.filter(row => row.kind === "Team")};
}

type Counted = { total_count: number | string; [key:string]: unknown };
function pagePayload(rows: Counted[], page: number) {
  return {
    rows: rows.map(({total_count, ...row}) => row),
    total: Number(rows[0]?.total_count ?? 0),
    page, pageSize,
  };
}

export async function communicationOversight(db: Db, actor: Actor, data: Record<string,unknown>, cutoff: string) {
  const access = requireOversight(actor);
  const section = pick(data.section, ["directory","conversations","activity"] as const, "oversight section");
  const query = str(data.query, "search", 100, false);
  const department = str(data.department, "department", 80, false);
  const team = str(data.team, "team", 80, false);
  const page = pageNumber(data.page);
  const offset = (page - 1) * pageSize;
  const units = await oversightUnits(db,actor,access);
  const base = { access, ...units, page, pageSize, total:0 };
  const filters = `${unitsFilter("Department")} AND ${unitsFilter("Team")}`;
  const filterArgs = [department,department,team,team];
  const personFilter = `(?='' OR strpos(lower(e.name),lower(?))>0 OR strpos(lower(COALESCE(e.title,'')),lower(?))>0)`;
  if (section === "directory" && (access.directory || access.employeeVisibility)) {
    const directory = access.directory ? communicationScope(actor, "communication.directory") : {sql:"1=0",args:[]};
    const edit = access.employeeVisibility ? communicationScope(actor,"communication.visibility.employee") : {sql:"1=0",args:[]};
    const activity = access.reports ? communicationScope(actor,"communication.reports") : {sql:"1=0",args:[]};
    const activityConversation = access.reports ? conversationScope(actor,"communication.reports") : {sql:"1=0",args:[]};
    const result = pagePayload(await all<Counted>(db, `SELECT e.id,e.name,e.title,e.status,d.name AS department,e.department_id,
      (SELECT string_agg(u.name, ', ' ORDER BY u.name) FROM units u WHERE u.org_id=e.org_id
        AND u.kind='Department' AND ${unitMember("e","u")}) AS departments,
      ARRAY(SELECT u.id FROM units u WHERE u.org_id=e.org_id AND u.kind='Department' AND ${unitMember("e","u")} ORDER BY u.name,u.id) AS department_ids,
      ${directoryVisibilityColumns()}, (${edit.sql}) AS can_edit,
      CASE WHEN (${activity.sql}) THEN (SELECT MAX(m.created_at) FROM messages m JOIN conversations c ON c.id=m.conversation_id
        WHERE m.sender_id=e.id AND c.org_id=e.org_id AND c.kind<>'External' AND m.created_at>=?
          AND m.deleted_at IS NULL AND (${activityConversation.sql})) END AS last_activity,
      count(*) OVER() AS total_count FROM employees e
      LEFT JOIN units d ON d.org_id=e.org_id AND d.id=e.department_id AND d.kind='Department'
      WHERE e.org_id=? AND e.role<>'guest' AND ((${directory.sql}) OR (${edit.sql})) AND ${filters} AND ${personFilter}
      ORDER BY e.name,e.id LIMIT ? OFFSET ?`,
    ...edit.args,...activity.args,cutoff,...activityConversation.args,actor.org_id,...directory.args,...edit.args,...filterArgs,query,query,query,pageSize,offset),page);
    await audit(db,actor,"Communication directory viewed","communication oversight").run();
    return json({...base,total:result.total,directory:result.rows});
  }
  if (section === "conversations" && access.metadata) {
    const metadata = conversationScope(actor,"communication.metadata");
    const content = access.content ? conversationScope(actor,"communication.content") : {sql:"1=0",args:[]};
    const sender = communicationScope(actor,"communication.metadata","author");
    const result = pagePayload(await all<Counted>(db, `SELECT c.id,c.title,c.kind,c.status,
    COALESCE((SELECT MAX(m.created_at) FROM messages m
      JOIN employees author ON author.id=m.sender_id AND author.org_id=c.org_id AND author.role<>'guest'
      WHERE m.conversation_id=c.id AND m.created_at>=? AND m.deleted_at IS NULL
        AND (${sender.sql})),c.created_at) AS last_activity,
    (SELECT string_agg(e.name, ', ' ORDER BY e.name,e.id) FROM conversation_members member
      JOIN employees e ON e.id=member.employee_id WHERE member.conversation_id=c.id) AS participants,
    (SELECT count(*)::int FROM conversation_members member WHERE member.conversation_id=c.id) AS participant_count,
    (${content.sql}) AS can_read,count(*) OVER() AS total_count
    FROM conversations c WHERE c.org_id=? AND c.kind<>'External' AND (${metadata.sql})
    AND ((?='' AND ?='' AND ?='') OR EXISTS(SELECT 1 FROM conversation_members member JOIN employees e ON e.id=member.employee_id
      WHERE member.conversation_id=c.id AND e.org_id=c.org_id AND ${filters} AND
        (?='' OR strpos(lower(e.name),lower(?))>0 OR (c.kind<>'Direct' AND strpos(lower(c.title),lower(?))>0))))
    ORDER BY last_activity DESC,c.id LIMIT ? OFFSET ?`,
    cutoff,...sender.args,...content.args,actor.org_id,...metadata.args,department,team,query,...filterArgs,query,query,query,pageSize,offset),page);
    await audit(db,actor,"Communication metadata viewed","communication oversight").run();
    return json({...base,total:result.total,conversations:result.rows});
  }
  if (section === "activity" && access.reports) {
    const report = communicationScope(actor,"communication.reports");
    const reportConversation = conversationScope(actor,"communication.reports");
    const result = pagePayload(await all<Counted>(db, `SELECT e.id,e.name,d.name AS department,
    (SELECT count(*)::int FROM conversation_members member JOIN conversations c ON c.id=member.conversation_id
      WHERE member.employee_id=e.id AND c.org_id=e.org_id AND c.kind<>'External' AND c.status='Active'
        AND (${reportConversation.sql})) AS conversations,
    (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE m.sender_id=e.id AND c.org_id=e.org_id AND c.kind<>'External' AND m.deleted_at IS NULL AND m.created_at>=?
        AND (${reportConversation.sql})) AS messages,
    (SELECT MAX(m.created_at) FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE m.sender_id=e.id AND c.org_id=e.org_id AND c.kind<>'External' AND m.deleted_at IS NULL AND m.created_at>=?
        AND (${reportConversation.sql})) AS last_activity,
    count(*) OVER() AS total_count FROM employees e LEFT JOIN units d ON d.org_id=e.org_id AND d.id=e.department_id
    WHERE e.org_id=? AND e.role<>'guest' AND (${report.sql}) AND ${filters} AND ${personFilter}
    ORDER BY last_activity DESC NULLS LAST,e.name,e.id LIMIT ? OFFSET ?`,
    ...reportConversation.args,cutoff,...reportConversation.args,cutoff,...reportConversation.args,
    actor.org_id,...report.args,...filterArgs,query,query,query,pageSize,offset),page);
    await audit(db,actor,"Communication activity report viewed","communication oversight").run();
    return json({...base,total:result.total,activity:result.rows});
  }
  return json(base);
}

export async function communicationContent(db: Db, actor: Actor, data: Record<string,unknown>, cutoff: string) {
  const access = requireOversight(actor);
  if (!access.content) return fail(403,"Explicit private conversation review permission is required.");
  const target = str(data.conversation,"conversation",80);
  const reason = str(data.reason,"review reason",500);
  if (reason.length < 8) return fail(400,"Enter a specific reason for reviewing private messages.");
  const page = pageNumber(data.page);
  const scope = conversationScope(actor,"communication.content");
  const conversation = await one<{id:string; title:string}>(db, `SELECT c.id,c.title FROM conversations c
    WHERE c.org_id=? AND c.id=? AND c.kind<>'External' AND c.status IN('Active','Removed')
      AND (${scope.sql}) FOR SHARE OF c`,actor.org_id,target,...scope.args);
  if (!conversation) return fail(404,"Conversation unavailable for review.");
  const sender = communicationScope(actor,"communication.content");
  const result = pagePayload(await all<Counted>(db, `SELECT m.id,e.name,m.body,m.created_at,count(*) OVER() AS total_count
      FROM messages m JOIN employees e ON e.id=m.sender_id AND e.org_id=? AND e.role<>'guest'
      WHERE m.conversation_id=? AND m.created_at>=? AND m.deleted_at IS NULL AND (${sender.sql})
      ORDER BY m.created_at DESC,m.id DESC LIMIT ? OFFSET ?`,
  actor.org_id,target,cutoff,...sender.args,pageSize,(page-1)*pageSize),page);
  await audit(db,actor,`Private communication reviewed · ${reason}`,"conversation",target).run();
  return json({title:conversation.title,...result});
}

export async function communicationVisibility(db: Db, actor: Actor, data: Record<string,unknown>) {
  const access = requireOversight(actor);
  const kind = pick(data.kind, ["employee","department","team"] as const,"visibility scope");
  const target = str(data.target,"visibility target",80);
  if (typeof data.hidden !== "boolean") return fail(400,"Choose whether to show or hide this entry.");
  const hidden = data.hidden;
  const label = hidden ? "hidden" : "shown";
  const timestamp = now();
  if (kind === "employee") {
    if (!access.employeeVisibility) return fail(403,"Employee visibility permission is required.");
    const scope = communicationScope(actor,"communication.visibility.employee");
    if (!await one(db,`SELECT e.id FROM employees e WHERE e.org_id=? AND e.id=?
      AND e.role<>'guest' AND (${scope.sql}) FOR SHARE OF e`,actor.org_id,target,...scope.args)) return fail(404,"Employee unavailable.");
    const revision = hidden
      ? await run(db,`INSERT INTO staff_communication_hidden_employees(org_id,employee_id,created_by,created_at)
          VALUES (?,?,?,?) ON CONFLICT DO NOTHING`,actor.org_id,target,actor.id,timestamp)
      : await run(db,"DELETE FROM staff_communication_hidden_employees WHERE org_id=? AND employee_id=?",actor.org_id,target);
    if (revision.count) {
      await audit(db,actor,`Employee ${label} in communication directory`,"employee",target).run();
      await run(db,`INSERT INTO notifications(id,employee_id,title,body,href)
        SELECT ?,e.id,'Communication directory settings updated','Your conversation history is still available.','/staff/messages'
        FROM employees e WHERE e.org_id=? AND e.id=? AND e.id<>? AND e.status='Active' AND e.employment_status<>'Ended'`,
      id(),actor.org_id,target,actor.id);
    }
    return json({ok:true});
  }
  if (!access.teamVisibility) return fail(403,"Team visibility permission is required.");
  const scope = unitEditScope(actor);
  const unitKind = kind === "team" ? "Team" : "Department";
  if (!await one(db,`SELECT u.id FROM units u WHERE u.org_id=? AND u.id=? AND u.kind=?
    AND (${scope.sql}) FOR SHARE OF u`,actor.org_id,target,unitKind,...scope.args)) return fail(404,"Department or team unavailable.");
  const revision = hidden
    ? await run(db,`INSERT INTO staff_communication_hidden_units(org_id,unit_id,created_by,created_at)
      VALUES (?,?,?,?) ON CONFLICT DO NOTHING`,actor.org_id,target,actor.id,timestamp)
    : await run(db,"DELETE FROM staff_communication_hidden_units WHERE org_id=? AND unit_id=?",actor.org_id,target);
  if (revision.count) {
    await audit(db,actor,`${unitKind} ${label} in communication directory`,"organization unit",target).run();
    await notifyUnit(db,actor,target,"Communication directory settings updated");
  }
  return json({ok:true});
}

async function notifyUnit(db: Db, actor: Actor, target: string, title: string) {
  await run(db,`INSERT INTO notifications(id,employee_id,title,body,href)
    SELECT ? || e.id,e.id,?,'Review your available contacts in Messages.','/staff/messages'
    FROM units u JOIN employees e ON e.org_id=u.org_id
    WHERE u.org_id=? AND u.id=? AND ${unitMember("e","u")} AND e.id<>? AND e.role<>'guest'
      AND e.status='Active' AND e.employment_status<>'Ended'`,id(),title,actor.org_id,target,actor.id);
}

export async function communicationSupport(db: Db, actor: Actor, data: Record<string,unknown>) {
  if (!communicationGovernanceEnabled()) return fail(404,"Communication governance is unavailable.");
  requireSuper(actor);
  const department = str(data.department,"support department",80);
  if (typeof data.enabled !== "boolean") return fail(400,"Choose whether to enable Support access.");
  if (!await one(db,`SELECT id FROM units WHERE org_id=? AND id=? AND kind='Department' FOR SHARE`,actor.org_id,department))
    return fail(404,"Department unavailable.");
  const changed = data.enabled
    ? await run(db,`INSERT INTO staff_communication_support_departments(org_id,unit_id) VALUES(?,?) ON CONFLICT DO NOTHING`,actor.org_id,department)
    : await run(db,`DELETE FROM staff_communication_support_departments WHERE org_id=? AND unit_id=?`,actor.org_id,department);
  if (changed.count) {
    await audit(db,actor,data.enabled?"Support communication enabled":"Support communication revoked","organization unit",department).run();
    await notifyUnit(db,actor,department,"Support communication access updated");
  }
  return json({ok:true});
}
