import {employmentEngineEnabled} from "./employment-catalog";
export const staffReadinessEnabled = () => process.env.WALSHKEN_STAFF_READINESS_ENABLED === "1";

export const staffActions = {
  "people.read": "View personnel records",
  "people.edit": "Edit personnel records",
  "people.status": "Suspend or reactivate staff",
  "payroll.read": "View authorized payroll records",
  "payroll.prepare": "Prepare payroll and rates",
  "payroll.approve": "Approve payroll",
  "payroll.finalize": "Finalize payroll",
  "payroll.payments": "Record payments and reversals",
} as const;
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
  const matching = rules.filter(rule => rule.action === action);
  const grants = matchingScopes(matching.filter(rule => rule.effect === "allow"), alias);
  const bans = matchingScopes(matching.filter(rule => rule.effect === "deny"), alias);
  return {
    sql: `((${fallback.sql}) OR (${grants.sql})) AND NOT COALESCE((${bans.sql}),false)`,
    args: [...fallback.args, ...grants.args, ...bans.args],
  };
}
