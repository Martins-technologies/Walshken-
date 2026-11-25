import {all, audit, fail, json, now, one, requireSuper, run, str, type Actor, type Db} from "./server";

export const managementTeamsEnabled = () => process.env.WALSHKEN_MANAGEMENT_TEAMS_ENABLED === "1";

export async function organizationMembershipData(db: Db, actor: Actor) {
  requireSuper(actor);
  const [staff, unitMemberships] = await Promise.all([
    all(db, `SELECT id,name,employee_no,department_id FROM employees
      WHERE org_id=? AND status='Active' AND employment_status<>'Ended' AND role<>'guest' ORDER BY name,id`, actor.org_id),
    all(db, `SELECT e.id,m.unit_id,e.id AS employee_id,e.name,e.employee_no,0 AS primary_department
      FROM staff_unit_memberships m JOIN employees e ON e.id=m.employee_id AND e.org_id=m.org_id
      WHERE m.org_id=? AND e.department_id IS DISTINCT FROM m.unit_id
      UNION ALL
      SELECT e.id,e.department_id,e.id,e.name,e.employee_no,1
      FROM employees e JOIN units u ON u.org_id=e.org_id AND u.id=e.department_id AND u.kind='Department'
      WHERE e.org_id=? AND e.role<>'guest'
      ORDER BY name,employee_id`, actor.org_id, actor.org_id),
  ]);
  return {managementTeams: true, staff, unitMemberships};
}

export async function organizationMembershipAction(db: Db, actor: Actor, action: string, data: Record<string, unknown>) {
  requireSuper(actor);
  if (!managementTeamsEnabled()) return fail(404, "Team and secondary department membership is disabled.");
  const unit = str(data.unit, "organization unit", 80);
  const employee = str(data.employee, "employee", 80);
  return db.transaction(async tx => {
    await one(tx, "SELECT id FROM organizations WHERE id=? FOR UPDATE", actor.org_id);
    const target = await one<{kind:string}>(tx, "SELECT kind FROM units WHERE org_id=? AND id=? AND kind IN ('Department','Team')", actor.org_id, unit);
    if (!target) return fail(404, "Department or team unavailable.");
    const member = await one<{department_id:string|null;status:string;employment_status:string}>(tx,
      "SELECT department_id,status,employment_status FROM employees WHERE org_id=? AND id=? AND role<>'guest'", actor.org_id, employee);
    if (!member) return fail(404, "Employee unavailable.");
    if (action === "membership-add") {
      if (member.status !== "Active" || member.employment_status === "Ended") return fail(409, "Choose an active employee.");
      if (target.kind === "Department" && member.department_id === unit) return json({ok:true,message:"This is already the employee’s primary department."});
      const result = await run(tx, `INSERT INTO staff_unit_memberships(org_id,employee_id,unit_id,created_by,created_at)
        VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`, actor.org_id, employee, unit, actor.id, now());
      if (!result.count) return json({ok:true,message:"Membership already exists."});
      await audit(tx, actor, `Employee ${employee} added to ${target.kind.toLowerCase()}`, "unit membership", unit).run();
      return json({ok:true,message:"Membership added."},201);
    }
    if (target.kind === "Department" && member.department_id === unit) return fail(409, "Change the primary department in the employee profile.");
    const result = await run(tx, "DELETE FROM staff_unit_memberships WHERE org_id=? AND employee_id=? AND unit_id=?", actor.org_id, employee, unit);
    if (!result.count) return json({ok:true,message:"Membership was already removed."});
    await audit(tx, actor, `Employee ${employee} removed from ${target.kind.toLowerCase()}`, "unit membership", unit).run();
    return json({ok:true,message:"Membership removed."});
  });
}
