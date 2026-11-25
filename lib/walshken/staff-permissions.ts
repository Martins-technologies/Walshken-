import {employmentEngineEnabled} from "./employment-catalog";
export const staffReadinessEnabled = () => process.env.WALSHKEN_STAFF_READINESS_ENABLED === "1";

export const staffActions = {
  "people.read": "View employee records",
  "people.create": "Create employees",
  "people.edit": "Edit employee profiles",
  "people.status": "Change employment and account status",
  "people.jurisdiction": "Change employment jurisdiction",
  "people.employment": "Update employment records",
  "people.sensitive": "View sensitive personnel information",
  "people.documents": "Manage employee documents",
  "leave.read": "View leave and absences",
  "shifts.read": "View employee schedules",
  "timesheets.read": "View timesheets",
  "attendance.policy": "Manage working-time and break policies",
  "leave.manage": "Manage leave requests",
  "leave.approve": "Approve leave",
  "attendance.read": "View attendance",
  "attendance.edit": "Edit attendance and submit corrections",
  "attendance.approve": "Approve timesheets",
  "attendance.corrections": "Approve attendance corrections",
  "shifts.manage": "Manage and publish shifts",
  "people.compensation": "Manage employee compensation",
  "payroll.read": "View payroll",
  "payroll.salary": "View individual salary and compensation history",
  "payroll.compensation": "Manage compensation",
  "payroll.employer": "Configure legal employer and statutory coverage",
  "payroll.employer.review": "Independently review employer statutory coverage",
  "payroll.providers": "Configure payroll providers",
  "payroll.rules": "Configure payroll rules",
  "payroll.periods": "Create and manage payroll periods",
  "payroll.calculate": "Calculate payroll",
  "payroll.review": "Review payroll inputs and calculations",
  "payroll.approve": "Approve payroll",
  "payroll.finalize": "Finalize payroll",
  "payroll.payslips": "Generate payslips",
  "payroll.export": "Export payroll reports",
  "payroll.adjustments": "Create payroll adjustments",
  "payroll.audit": "View payroll audit history",
  "payroll.payments": "Record payments and reversals",
  "payroll.prepare": "Legacy payroll preparation authority",
  "privacy.manage": "Manage privacy and archival requests",
  "privacy.export": "Approve personal data exports",
  "privacy.dispose": "Approve record disposal",
  "audit.read": "View authorized audit history",
  "audit.export": "Export authorized audit history",
  "security.scans": "Review and retry upload scans",
} as const;
export const legacyPreparationActions = new Set<StaffAction>([
 'payroll.compensation','payroll.rules','payroll.periods','payroll.calculate','payroll.adjustments'
]);
export type StaffAction = keyof typeof staffActions;

export type StaffPermission = {
  id: string;
  action: StaffAction;
  scope_type: "organization" | "division" | "department" | "employee" | "country" | "office";
  scope_id: string;
  effect: "allow" | "deny";
};
type Clause = { sql: string; args: unknown[] };

function matchingScopes(rules: StaffPermission[], alias: string): Clause {
  const scopes = { division: "division_id", department: "department_id", employee: "id",country:"country",office:"office_id" } as const;
  if (rules.some(rule => rule.scope_type === "organization")) return {sql:"1=1", args:[]};
  if (!rules.length) return {sql:"1=0", args:[]};
  return {
    sql: rules.map(rule => {
      const column=scopes[rule.scope_type as keyof typeof scopes];
      if(employmentEngineEnabled()&&(rule.scope_type==='country'||rule.scope_type==='office'))return `COALESCE((SELECT t.${column} FROM staff_employment_terms t WHERE t.org_id=${alias}.org_id AND t.employee_id=${alias}.id AND t.effective_on<=to_char(now() AT TIME ZONE ${alias}.time_zone,'YYYY-MM-DD') ORDER BY t.effective_on DESC LIMIT 1),${alias}.${column})=?`;
      return `${alias}.${column}=?`;
    }).join(" OR "),
    args: rules.map(rule => rule.scope_id),
  };
}

export function permissionScope(rules: StaffPermission[], action: StaffAction, alias: string, fallback: Clause): Clause {
  const matching = rules.filter(rule => rule.action === action || action==='payroll.compensation'&&rule.action==='people.compensation' || legacyPreparationActions.has(action) && rule.action === "payroll.prepare");
  const grants = matchingScopes(matching.filter(rule => rule.effect === "allow"), alias);
  const bans = matchingScopes(matching.filter(rule => rule.effect === "deny"), alias);
  return {
    sql: `((${fallback.sql}) OR (${grants.sql})) AND NOT COALESCE((${bans.sql}),false)`,
    args: [...fallback.args, ...grants.args, ...bans.args],
  };
}
