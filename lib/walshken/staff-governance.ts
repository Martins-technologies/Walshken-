import {retentionData,retentionAction} from "./retention";
import {scanHistory} from "./upload-quarantine";
import {employmentEngineEnabled} from "./employment-catalog";
import {employmentAction,employmentData} from "./employment-admin";
import { randomBytes } from "node:crypto";
import { passwordHash, passwordMatches } from "./passwords";
import { verifyStaffMfa } from "./staff-mfa";
import { roles } from "./catalog";
import { canManage, canSuper, requireSuper, requireStaff, scope, all, one, run, audit, now, id, str, pick, json, fail, digest, throttle, type Actor, type Db } from "./server";
import { permissionScope, staffActions, staffReadinessEnabled, type StaffAction } from "./staff-permissions";
import { jurisdictionAction, jurisdictionVersions } from "./jurisdiction-readiness";
import { workDataset } from "./workforce";

export function peopleScope(actor: Actor, action: StaffAction, alias = "e", includeSelf = false) {
  if (canSuper(actor)) return scope(actor, alias, includeSelf);
  const fallback = ((!includeSelf && ["hr","admin"].includes(actor.role) && staffReadinessEnabled())
    || (action !== "people.edit" && canManage(actor) && actor.role !== "manager")) ? scope(actor, alias, includeSelf) : {sql:"1=0", args:[]};
  return permissionScope(actor.permissions ?? [], action, alias, fallback);
}

export async function currentNotice(db: Db, actor: Actor) {
  if (!staffReadinessEnabled() || actor.role === "guest") return null;
  return one(db, `SELECT n.id,n.title,n.body,n.created_at,a.created_at AS acknowledged_at
    FROM staff_privacy_notices n LEFT JOIN staff_privacy_acknowledgements a ON a.notice_id=n.id AND a.employee_id=?
    WHERE n.org_id=? ORDER BY n.created_at DESC,n.id DESC LIMIT 1`,actor.id,actor.org_id);
}

export async function governanceAction(db: Db, actor: Actor, action: string, data: Record<string,unknown>) {
  if (!staffReadinessEnabled()) return fail(404,"Staff governance is unavailable.");
  requireStaff(actor);
  await throttle(db,`governance:${actor.id}`,30,60_000);
  if (action === "notice-acknowledge") {
    const notice = await currentNotice(db,actor);
    if (!notice || notice.id !== data.id) return fail(409,"Open the current privacy notice before acknowledging it.");
    await run(db,"INSERT INTO staff_privacy_acknowledgements(notice_id,employee_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING",notice.id,actor.id,now());
    return json({ok:true,message:"Acknowledgement saved."});
  }
  requireSuper(actor);
  if(action.startsWith('retention-')||action.startsWith('hold-'))return retentionAction(db,actor,action,data);
  if(action.startsWith("employment-"))return employmentAction(db,actor,action,data);
  if (["jurisdiction-save","jurisdiction-verify","jurisdiction-withdraw"].includes(action)) return jurisdictionAction(db,actor,action,data);
  if (action === "notice-publish") {
    const notice = id();
    await db.transaction(async tx => {
      await run(tx,"INSERT INTO staff_privacy_notices(id,org_id,title,body,created_by,created_at) VALUES(?,?,?,?,?,?)",notice,actor.org_id,str(data.title,"title",120),str(data.body,"notice",10_000),actor.id,now());
      await audit(tx,actor,"Staff privacy notice published","privacy notice",notice).run();
    });
    return json({ok:true,message:"Notice published to staff profiles."});
  }
  if (action === "permission-remove") {
    const target = str(data.id,"permission",80);
    await db.transaction(async tx => {
      const changed = await run(tx,"DELETE FROM staff_action_permissions WHERE id=? AND org_id=?",target,actor.org_id);
      if (!changed.count) return fail(404,"Permission unavailable.");
      await audit(tx,actor,"Scoped action permission removed","staff permission",target).run();
    });
    return json({ok:true,message:"Permission removed."});
  }
  if (action === "permission-save") {
    const principalType = pick(data.principalType,["employee","role"] as const,"principal type");
    const principal = str(data.principal,"employee ID or role",80);
    const scopeType = pick(data.scopeType,["organization","division","department","employee",...(employmentEngineEnabled()?["country","office"]:[])] as const,"scope");
    const target = scopeType === "organization" ? actor.org_id : str(data.scopeId,"target ID",80);
    const capability = pick(data.capability,Object.keys(staffActions) as StaffAction[],"action");
    const effect = pick(data.effect,["allow","deny"] as const,"effect");
    if (principalType === "role") pick(principal,roles.filter(role=>!["super_admin","guest"].includes(role)),"internal role");
    else if (!await one(db,"SELECT id FROM employees WHERE org_id=? AND id=? AND role NOT IN ('super_admin','guest')",actor.org_id,principal)) return fail(404,"Employee unavailable.");
    if(scopeType==='country')pick(target,['CA','IN','PK'],'employment country');
    if(scopeType==='office'&&!await one(db,"SELECT id FROM units WHERE org_id=? AND id=? AND kind='Office'",actor.org_id,target))return fail(404,'Office unavailable.');
    if (scopeType === "employee" && !await one(db,"SELECT id FROM employees WHERE org_id=? AND id=? AND role<>'guest'",actor.org_id,target)) return fail(404,"Employee unavailable.");
    if ((scopeType === "division" || scopeType === "department") && !await one(db,"SELECT id FROM units WHERE org_id=? AND id=? AND lower(kind)=?",actor.org_id,target,scopeType)) return fail(404,"Organization unit unavailable.");
    await db.transaction(async tx => {
      const saved = await one<{id:string}>(tx,`INSERT INTO staff_action_permissions
        (id,org_id,principal_type,principal_id,scope_type,scope_id,action,effect,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(org_id,principal_type,principal_id,scope_type,scope_id,action)
        DO UPDATE SET effect=excluded.effect,created_by=excluded.created_by,created_at=excluded.created_at RETURNING id`,
        id(),actor.org_id,principalType,principal,scopeType,target,capability,effect,actor.id,now());
      await audit(tx,actor,`Scoped action permission saved: ${effect} ${capability}`,"staff permission",saved?.id).run();
    });
    return json({ok:true,message:"Scoped permission saved."});
  }
  if (action === "reporting-review") {
    const target = str(data.attendance,"attendance record ID",80);
    const classification = pick(data.classification,["Required","Voluntary early departure","Employee-requested short work"] as const,"reporting classification");
    const reason = str(data.reason,"factual evidence for the decision",1500);
    await db.transaction(async tx => {
      const row = await one<{employee_id:string;revision:number}>(tx,"SELECT employee_id,revision FROM attendance WHERE id=? AND org_id=? AND release_stage=? AND ends_at IS NOT NULL FOR UPDATE",target,actor.org_id,workDataset());
      if (!row || row.employee_id === actor.id) return fail(403,"A separate administrator must review this attendance record.");
      if (await one(tx,`SELECT s.id FROM payroll_sources s JOIN timesheets t ON t.id=s.source_id
        WHERE t.attendance_id=? AND s.finalized=1`,target)) return fail(409,"This attendance was finalized. Record any change through a payroll adjustment.");
      await run(tx,"INSERT INTO staff_reporting_reviews(id,org_id,attendance_id,attendance_revision,release_stage,classification,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        id(),actor.org_id,target,row.revision,workDataset(),classification,reason,actor.id,now());
      await audit(tx,actor,`Reporting pay classification: ${classification}`,"attendance",target).run();
    });
    return json({ok:true,message:"Reporting decision saved for this attendance revision."});
  }
  if (action !== "appoint-super" && action !== "recover-mfa") return fail(404,"This action is unavailable.");
  const target = str(data.employee,"employee",80);
  if (target === actor.id) return fail(403,"Use a separate administrator for this action.");
  return db.transaction(async tx => {
    await one(tx,"SELECT id FROM organizations WHERE id=? FOR UPDATE",actor.org_id);
    const current = await one<{password_hash:string}>(tx,"SELECT password_hash FROM credentials WHERE employee_id=? FOR UPDATE",actor.id);
    if (!await passwordMatches(str(data.password,"current password",160),current?.password_hash)) return fail(401,"Current password is incorrect.");
    await verifyStaffMfa(tx,actor.id,data.code,true);
    const employee = await one<Actor>(tx,"SELECT * FROM employees WHERE org_id=? AND id=? AND status='Active' AND employment_status<>'Ended' AND role<>'guest' FOR UPDATE",actor.org_id,target);
    if (!employee) return fail(404,"Active employee unavailable.");
    if (action === "appoint-super") {
      if (employee.role !== "admin") return fail(409,"Appoint a current Admin to the Super Admin role.");
      if (!await one(tx,"SELECT employee_id FROM staff_mfa WHERE employee_id=? AND confirmed_at IS NOT NULL",target)) return fail(409,"The receiving administrator must enroll in MFA first.");
      await run(tx,"UPDATE employees SET role='super_admin' WHERE id=?",target);
      await run(tx,"UPDATE sessions SET ended_at=? WHERE employee_id=? AND ended_at IS NULL",now(),target);
      await audit(tx,actor,"Super Admin appointed","employee",target).run();
      return json({ok:true,message:"Super Admin appointed. They must sign in again."});
    }
    const reference = str(data.reason,"verified identity recovery reference",1000);
    if (reference.length < 12) return fail(400,"Record the identity verification reference.");
    const code = randomBytes(27).toString("base64url");
    const at = now();
    await run(tx,"UPDATE credentials SET password_hash=?,updated_at=? WHERE employee_id=?",await passwordHash(randomBytes(32).toString("hex")),at,target);
    await run(tx,"UPDATE sessions SET ended_at=? WHERE employee_id=? AND ended_at IS NULL",at,target);
    await run(tx,"UPDATE invitations SET consumed_at=? WHERE employee_id=? AND consumed_at IS NULL",at,target);
    await run(tx,"DELETE FROM staff_recovery_codes WHERE employee_id=?",target);
    await run(tx,"DELETE FROM staff_mfa WHERE employee_id=?",target);
    await run(tx,"INSERT INTO invitations(id,employee_id,code_hash,expires_at) VALUES(?,?,?,?)",id(),target,await digest(code),new Date(Date.now()+30*60_000).toISOString());
    const evidenceHash = await digest(reference);
    await audit(tx,actor,`MFA recovery authorized · identity reference SHA-256 ${evidenceHash}`,"employee",target).run();
    return json({ok:true,code,message:"Recovery code created. It expires in 30 minutes. The employee will enroll a fresh authenticator."});
  });
}

export async function governanceData(db: Db, actor: Actor) {
  requireSuper(actor);
  const [rules, employees, units, notice, policies, employment, scans, retention] = await Promise.all([
    all(db,`SELECT r.id,r.principal_type,r.principal_id,r.scope_type,r.scope_id,r.action,r.effect,r.created_at,
      COALESCE(p.name,r.principal_id) AS principal,COALESCE(t.name,u.name,r.scope_id) AS scope
      FROM staff_action_permissions r LEFT JOIN employees p ON r.principal_type='employee' AND p.id=r.principal_id
      LEFT JOIN employees t ON r.scope_type='employee' AND t.id=r.scope_id
      LEFT JOIN units u ON r.scope_type IN ('division','department','office') AND u.id=r.scope_id
      WHERE r.org_id=? ORDER BY r.created_at DESC`,actor.org_id),
    all(db,"SELECT id,name,role FROM employees WHERE org_id=? AND status='Active' AND role<>'guest' ORDER BY name",actor.org_id),
    all(db,"SELECT id,name,kind FROM units WHERE org_id=? AND kind IN ('Division','Department','Office') ORDER BY name",actor.org_id),
    currentNotice(db,actor),
    jurisdictionVersions(db,actor),
    employmentData(db,actor),
    employmentEngineEnabled()?scanHistory(db,actor):Promise.resolve([]),
    retentionData(db,actor),
  ]);
  const acknowledgements = notice ? await all(db,`SELECT e.id,e.name,a.created_at
    FROM employees e LEFT JOIN staff_privacy_acknowledgements a ON a.employee_id=e.id AND a.notice_id=?
    WHERE e.org_id=? AND e.status='Active' AND e.role<>'guest' ORDER BY e.name`,notice.id,actor.org_id) : [];
  return json({rows:rules,staff:employees,units,privacyNotice:notice,acknowledgements,jurisdictionPolicies:policies,employment,scans,retention,scanRequired:process.env.WALSHKEN_MALWARE_SCANNING_REQUIRED!=="0"});
}
