import { all, canManage, canSuper, fail, json, one, requireStaff, str, type Actor, type Db } from "./server";
import { permissionScope, staffReadinessEnabled, type StaffAction, type StaffPermission } from "./staff-permissions";

export const communicationGovernanceEnabled = () => process.env.WALSHKEN_MANAGEMENT_COMMS_ENABLED === "1";
export const communicationOversightActions = {
  directory: "communication.directory",
  metadata: "communication.metadata",
  reports: "communication.reports",
  content: "communication.content",
  employeeVisibility: "communication.visibility.employee",
  teamVisibility: "communication.visibility.team",
} as const;

export function communicationAccess(actor: Actor) {
  const management = canManage(actor) && communicationGovernanceEnabled();
  const actions = Object.fromEntries(Object.entries(communicationOversightActions).map(([key, action]) => {
    const rules = actor.permissions?.filter(rule => rule.action === action) ?? [];
    const allowed = canSuper(actor) || rules.some(rule => rule.effect === "allow") &&
      !rules.some(rule => rule.effect === "deny" && rule.scope_type === "organization");
    return [key, management && allowed];
  })) as Record<keyof typeof communicationOversightActions, boolean>;
  return { ...actions, policy: management && canSuper(actor) };
}

export function communicationScope(actor: Actor, action: StaffAction, alias = "e") {
  if (canSuper(actor)) return { sql: "1=1", args: [] };
  return permissionScope(actor.permissions ?? [], action, alias, {sql:"1=0",args:[]}, true);
}

export function unitMember(employee: string, unit: string) {
  return `((${unit}.kind='Department' AND ${employee}.department_id=${unit}.id) OR EXISTS(
    SELECT 1 FROM staff_unit_memberships membership WHERE membership.org_id=${employee}.org_id
      AND membership.employee_id=${employee}.id AND membership.unit_id=${unit}.id
  ))`;
}

const supportMember = (employee: string) => `EXISTS(
  SELECT 1 FROM staff_communication_support_departments s JOIN units u
    ON u.id=s.unit_id AND u.org_id=s.org_id AND u.kind='Department'
  WHERE s.org_id=${employee}.org_id AND ${unitMember(employee,"u")}
)`;

const individuallyHidden = (alias: string) => `EXISTS(
  SELECT 1 FROM staff_communication_hidden_employees h WHERE h.org_id=${alias}.org_id AND h.employee_id=${alias}.id
)`;
const unitHidden = (alias: string, kind: "Department" | "Team") => `EXISTS(
  SELECT 1 FROM staff_communication_hidden_units h JOIN units u ON u.id=h.unit_id AND u.org_id=h.org_id
  WHERE h.org_id=${alias}.org_id AND u.kind='${kind}' AND ${unitMember(alias,"u")}
)`;
export const directoryVisibilityColumns = (alias = "e") => `
  ${individuallyHidden(alias)} AS hidden,
  ${unitHidden(alias,"Department")} AS department_hidden,
  ${unitHidden(alias,"Team")} AS team_hidden`;

export const visibleInCommunicationDirectory = (alias = "e") =>
  `NOT (${individuallyHidden(alias)} OR ${unitHidden(alias,"Department")} OR ${unitHidden(alias,"Team")})`;

function departmentOverlap(employee: string) {
  return `EXISTS(
    SELECT 1 FROM units u WHERE u.org_id=${employee}.org_id AND u.kind='Department'
    AND ${unitMember(employee,"u")}
    AND (u.id=? OR EXISTS(SELECT 1 FROM staff_unit_memberships source
      WHERE source.org_id=u.org_id AND source.unit_id=u.id AND source.employee_id=?))
  )`;
}

export function directPeers(actor: Actor, alias = "e", useDirectGrants = true) {
  if (canSuper(actor)) return { sql: "1=1", args: [] };
  const fallback = {
    sql: `${departmentOverlap(alias)} ${useDirectGrants ? `OR ${alias}.role='super_admin'` : ""}
      OR ${alias}.manager_id=? OR ${alias}.id=? OR ${supportMember(alias)}
      OR EXISTS(SELECT 1 FROM employees sender WHERE sender.org_id=${alias}.org_id
        AND sender.id=? AND ${supportMember("sender")})`,
    args: [actor.department_id, actor.id, actor.id, actor.manager_id, actor.id],
  };
  return useDirectGrants
    ? permissionScope(actor.permissions ?? [], "communication.direct", alias, fallback, true)
    : fallback;
}

type DirectPeer = Actor & { shared_department: boolean; support_access: boolean; quiet: boolean };
async function peerDirectPermissions(db: Db, actor: Actor, peer: Pick<Actor, "id" | "role">) {
  if (!staffReadinessEnabled() || peer.role === "super_admin") return [];
  return all<StaffPermission>(db, `SELECT id,action,scope_type,scope_id,effect
    FROM staff_action_permissions WHERE org_id=? AND action='communication.direct'
      AND ((principal_type='employee' AND principal_id=?) OR (principal_type='role' AND principal_id=?))`,
  actor.org_id, peer.id, peer.role);
}

async function allowsDirectSender(db: Db, actor: Actor, rules: StaffPermission[], otherwiseAllowed: boolean) {
  if (!rules.length) return otherwiseAllowed;
  const scope = permissionScope(rules, "communication.direct", "e", {sql:otherwiseAllowed ? "1=1" : "1=0",args:[]}, true);
  return Boolean(await one(db,`SELECT e.id FROM employees e WHERE e.org_id=? AND e.id=? AND (${scope.sql})`,
    actor.org_id, actor.id, ...scope.args));
}

export async function directPeer(db: Db, actor: Actor, target: string) {
  requireStaff(actor);
  const permitted = directPeers(actor);
  const quiet = communicationScope(actor, "communication.direct.silent");
  const peer = await one<DirectPeer>(db, `SELECT e.*, ${departmentOverlap("e")} AS shared_department,
    (${supportMember("e")} OR EXISTS(SELECT 1 FROM employees sender WHERE sender.org_id=e.org_id
      AND sender.id=? AND ${supportMember("sender")})) AS support_access,
    (${quiet.sql}) AS quiet
    FROM employees e WHERE e.org_id=? AND e.id=? AND e.id<>? AND e.role<>'guest'
    AND e.status='Active' AND e.employment_status<>'Ended' AND (${permitted.sql})`,
  actor.department_id, actor.id, actor.id, ...quiet.args, actor.org_id, target, actor.id, ...permitted.args);
  if (!peer || !await allowsDirectSender(db,actor,
    (await peerDirectPermissions(db,actor,peer)).filter(rule => rule.effect === "deny"),true,
  )) return fail(404, "This teammate is outside your current messaging scope.");
  return peer;
}

export async function existingDirect(db: Db, actor: Actor, employee: string) {
  return one<{id:string}>(db, `SELECT c.id FROM conversations c
    JOIN conversation_members own ON own.conversation_id=c.id AND own.employee_id=?
    JOIN conversation_members peer ON peer.conversation_id=c.id AND peer.employee_id=?
    WHERE c.org_id=? AND c.kind='Direct' AND c.status='Active'`, actor.id, employee, actor.org_id);
}

export async function authorizedDirectReply(db: Db, actor: Actor, conversation: string) {
  requireStaff(actor);
  const outgoing = directPeers(actor);
  const noOutgoingDeny = canSuper(actor) ? {sql:"1=1",args:[]} : permissionScope(
    (actor.permissions ?? []).filter(rule => rule.effect === "deny"), "communication.direct", "e", {sql:"1=1",args:[]}, true,
  );
  const peer = await one<Pick<Actor, "id" | "role"> & {outgoing:boolean}>(db, `SELECT e.id,e.role,(${outgoing.sql}) AS outgoing
    FROM conversation_members member JOIN employees e ON e.id=member.employee_id
    JOIN conversations c ON c.id=member.conversation_id AND c.org_id=e.org_id
    JOIN conversation_members self ON self.conversation_id=c.id AND self.employee_id=?
    WHERE c.id=? AND c.org_id=? AND c.kind='Direct' AND c.status='Active' AND e.id<>? AND e.role<>'guest'
      AND e.status='Active' AND e.employment_status<>'Ended' AND (${noOutgoingDeny.sql})`,
  ...outgoing.args, actor.id, conversation, actor.org_id, actor.id, ...noOutgoingDeny.args);
  if (!peer) return false;
  return allowsDirectSender(db,actor,await peerDirectPermissions(db,actor,peer),peer.outgoing);
}

export function mustConfirmCrossDepartment(peer: DirectPeer) {
  return !peer.shared_department && !peer.support_access && !peer.quiet;
}

export async function checkDirect(db: Db, actor: Actor, data: Record<string, unknown>) {
  const employee = str(data.employee, "recipient", 80);
  const peer = await directPeer(db, actor, employee);
  const existing = await existingDirect(db, actor, employee);
  return json({ confirmationRequired: !existing && mustConfirmCrossDepartment(peer) });
}

export async function communicationPeople(db: Db, actor: Actor, data: Record<string, unknown>) {
  requireStaff(actor);
  const query = str(data.query, "employee search", 100, false);
  const peers = directPeers(actor);
  const rows = await all(db, `SELECT e.id,e.name,e.title,departments.names AS department, ${supportMember("e")} AS support
    FROM employees e CROSS JOIN LATERAL (
      SELECT string_agg(u.name, ', ' ORDER BY u.name) AS names FROM units u
      WHERE u.org_id=e.org_id AND u.kind='Department' AND ${unitMember("e","u")}
    ) departments
    WHERE e.org_id=? AND e.id<>? AND e.status='Active' AND e.employment_status<>'Ended' AND e.role<>'guest'
    AND (${peers.sql}) AND ${visibleInCommunicationDirectory()}
    AND (?='' OR strpos(lower(e.name),lower(?))>0 OR strpos(lower(COALESCE(departments.names,'')),lower(?))>0)
    ORDER BY e.name,e.id LIMIT 40`,
  actor.org_id, actor.id, ...peers.args, query, query, query);
  return json({ rows });
}

export async function communicationGroupPeople(db: Db, actor: Actor) {
  if (actor.role === "guest") return [];
  const peers = directPeers(actor, "e", false);
  return all<import("./server").Row>(db, `SELECT e.id,e.name,e.title,e.employee_no,u.name AS department
    FROM employees e LEFT JOIN units u ON u.id=e.department_id AND u.org_id=e.org_id AND u.kind='Department'
    WHERE e.org_id=? AND e.status='Active' AND e.employment_status<>'Ended' AND e.role<>'guest'
    AND (e.id=? OR (${peers.sql})) AND ${visibleInCommunicationDirectory()}
    ORDER BY e.name,e.id LIMIT 200`, actor.org_id, actor.id, ...peers.args);
}

export async function eligibleGroupPeer(db: Db, actor: Actor, target: string) {
  const peers = directPeers(actor, "e", false);
  const peer = await one<Actor>(db, `SELECT e.* FROM employees e WHERE e.org_id=? AND e.id=?
    AND e.status='Active' AND e.employment_status<>'Ended' AND e.role<>'guest' AND (${peers.sql})`,
  actor.org_id, target, ...peers.args);
  if (!peer) return fail(404,"That teammate is outside your communication scope.");
  return peer;
}

export async function inCommunicationDepartment(db: Db, actor: Actor, department: string) {
  return Boolean(await one(db, `SELECT u.id FROM units u JOIN employees e ON e.org_id=u.org_id
    WHERE u.org_id=? AND u.id=? AND u.kind='Department' AND e.id=? AND ${unitMember("e","u")}`,
  actor.org_id, department, actor.id));
}
