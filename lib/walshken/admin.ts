import {requireEmployeeAction,requireOrganizationAction} from './staff-authority';
import {integrationSettings} from "./integration-settings";
import {employmentTermsOn} from "./employment-engine";
import {localDate} from "./work";
import {validateMessageRetention} from "./retention";
import {employmentEngineEnabled} from "./employment-catalog";
import { verifiedStaffLocation } from "./jurisdiction-readiness";
import {staffReadinessEnabled} from "./staff-permissions";
import {peopleScope} from "./staff-governance";
import {sendAccessCode,validateEmailSettings,verifyScanner} from "./staff-delivery";
import { passwordMatches } from "./passwords";
import { documentsEnabled } from "./document-access";
import {payrollEnabled} from "./payroll-access";
import {calculatorIntegrationId,validateCalculatorSettings,verifyCalculatorConnection,type CalculatorSettings} from "./payroll-calculator";
import { verifyStaffMfa } from "./staff-mfa";
import { randomBytes } from "node:crypto";
import { inquiryStatuses } from "./customer-status";
import { divisions, providers, roles } from "./catalog";
import { communicationAdmin, communicationPolicy, retentionCutoff } from "./collaboration";
import { verifyLiveKitConnection, verifyRecordingStorage, validateLiveKit, validateStorage, type LiveKitSettings, type RecordingStorage } from "./livekit";
import {
  all, audit, canManage, canPayroll, canSuper, country, date, destination, digest, email, decryptSettings, encryptSettings,
  fail, id, integer, json, now, one, pick, requireSuper, run, scopedEmployee, stmt, str, throttle, timeZone, type Actor, type Db,
} from "./server";

const employmentStatuses = ["Active", "On leave", "Ended"] as const;
const types = ["Full-time", "Part-time", "Fixed-term", "Contractor"] as const;

export async function adminAction(db: Db, actor: Actor, area: string, action: string, data: Record<string, unknown>) {
  if (area === "employees") {
    if ((!canManage(actor) || actor.role === "manager") && !actor.permissions?.some(rule=>rule.effect==="allow" && rule.action.startsWith("people."))) return fail(403,"Employee administration access is required.");
    if (action === "add") {
      if(staffReadinessEnabled())await requireOrganizationAction(db,actor,'people.create');else requireSuper(actor);
      const target = id();
      const role = pick(data.role, roles.filter((role) => role !== "super_admin"), "staff role");
      if(!canSuper(actor)&&role!=='employee')return fail(403,'Only a Super Admin may create privileged staff accounts.');
      const department = str(data.department, "department", 80, false);
      const division = str(data.division, "division", 80, false);
      const office = str(data.office, "office", 80, false);
      const manager = str(data.manager, "manager", 80, false);
      for (const [key, kind] of [[department,"Department"],[division,"Division"],[office,"Office"]]) {
        if (key && !await one(db, "SELECT id FROM units WHERE id=? AND org_id=? AND kind=?", key, actor.org_id, kind)) fail(400, `Choose a valid ${kind.toLowerCase()}.`);
      }
      if (manager) {
        const supervisor = await scopedEmployee(db, actor, manager);
        if (!canManage(supervisor) || supervisor.status !== "Active" || supervisor.employment_status === "Ended") fail(400, "Choose an active manager.");
      }
      const officeCountry=country(data.country), jurisdiction=str(data.jurisdiction,"jurisdiction",30);
      if(staffReadinessEnabled()) verifiedStaffLocation(officeCountry,jurisdiction);
      const code = randomBytes(27).toString("base64url");
      await db.batch([
        stmt(db, `INSERT INTO employees
          (id,org_id,employee_no,name,email,role,title,department_id,division_id,office_id,manager_id,country,jurisdiction,time_zone,
          employment_type,hire_date,contract_start,phone,expected_hours,break_policy,leave_days)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, target, actor.org_id, str(data.employeeNo,"employee ID",40),
          str(data.name,"employee name",100), email(data.email), role, str(data.title,"job title",100,false), department || null,
          division || null, office || null, manager || null, officeCountry, jurisdiction,
          timeZone(data.timeZone), pick(data.employmentType || "Full-time",types,"employment type"),
          date(data.hireDate,"hire date",false), date(data.contractStart,"contract start date",false), str(data.phone,"phone number",40,false) || null,
          integer(data.expectedHours === "" || data.expectedHours == null ? "40" : data.expectedHours,"expected weekly hours",0,80), pick(data.breakPolicy || "unpaid",["paid","unpaid"],"break policy"),
          data.leaveDays !== "" && data.leaveDays != null ? integer(data.leaveDays,"leave days",0,365) : null),
        stmt(db, "INSERT INTO invitations (id,employee_id,code_hash,expires_at) VALUES (?,?,?,?)", id(), target, await digest(code), new Date(Date.now() + 48 * 3_600_000).toISOString()),
        audit(db, actor, "Employee created", "employee", target),
      ]);
      return json({ ok: true, code, message: "Employee created. The activation code expires in 48 hours." }, 201);
    }
    const target = str(data.id, "employee", 80);
    const editingOwnAdmin = action==="edit" && target===actor.id && canSuper(actor);
    const personnelAction = action==="status" ? "people.status" : "people.edit";
    const visible = peopleScope(actor,personnelAction);
    const employee = staffReadinessEnabled() && !canSuper(actor) && ["edit","status"].includes(action)
      ? await one<Actor>(db,`SELECT e.* FROM employees e WHERE e.org_id=? AND e.id=? AND e.id<>? AND e.role='employee' AND ${visible.sql}`,actor.org_id,target,actor.id,...visible.args)
      : await scopedEmployee(db,actor,target,editingOwnAdmin);
    if (!employee) return fail(404,"Employee unavailable for this action.");
    if (employee.role === "super_admin" && !editingOwnAdmin) return fail(403, "This administrator is protected.");
    if (action === "edit" && !canSuper(actor) && data.fullEmployment!==true) {
      if (!staffReadinessEnabled()) return fail(403,"Super Admin access is required.");
      await db.transaction(async tx => {
        const updated = await run(tx,`UPDATE employees e SET name=?,title=?,phone=? WHERE e.org_id=? AND e.id=? AND e.role='employee' AND ${visible.sql}`,
          str(data.name,"name",100),str(data.title,"title",100,false),str(data.phone,"phone number",40,false)||null,actor.org_id,target,...visible.args);
        if (!updated.count) return fail(404,"Employee unavailable for this action.");
        await audit(tx,actor,"Scoped personnel details updated","employee",target).run();
      });
      return json({ok:true,message:"Personnel details saved."});
    }
    if (action === "edit") {
      if(!canSuper(actor)){await requireEmployeeAction(db,actor,'people.edit',target,false);await requireEmployeeAction(db,actor,'people.employment',target,false);if(employee.country!==data.country||employee.jurisdiction!==data.jurisdiction)await requireEmployeeAction(db,actor,'people.jurisdiction',target,false);}
      const employeeNo = data.employeeNo === undefined ? employee.employee_no : str(data.employeeNo,"employee ID",40);
      const workEmail = data.email === undefined ? employee.email : email(data.email);
      const department = str(data.department, "department", 80, false);
      const division = str(data.division, "division", 80, false);
      const office = str(data.office, "office", 80, false);
      const manager = str(data.manager, "manager", 80, false);
      const hire = date(data.hireDate, "hire date", false);
      const contract = date(data.contractStart, "contract start date", false);
      const end = date(data.employmentEnd, "employment end date", false);
      const officeCountry=country(data.country), jurisdiction=str(data.jurisdiction,"jurisdiction",30);
      if(await employmentTermsOn(db,employee,localDate(now(),employee.time_zone))){
        const baseline=await one<{employment_type:string;expected_hours:number}>(db,'SELECT employment_type,expected_hours FROM employees WHERE id=?',employee.id);
        if(officeCountry!==employee.country||jurisdiction!==employee.jurisdiction||data.timeZone!==employee.time_zone||data.employmentType!==baseline?.employment_type||str(data.office,'office',80,false)!==(employee.office_id??'')||Number(data.expectedHours)!==Number(baseline?.expected_hours))return fail(409,'This employee has effective employment assignments. Update work location, classification, office and working hours through Staff policies → Employment assignments.');
      }
      if(staffReadinessEnabled()) verifiedStaffLocation(officeCountry,jurisdiction);
      const employmentStatus = pick(data.employmentStatus ?? employee.employment_status ?? "Active",employmentStatuses,"employment status");
      if (employmentStatus==="Ended" && (editingOwnAdmin || !end)) {
        fail(400,editingOwnAdmin?"The Super Admin record must remain active.":"Record the end date before ending employment.");
      }
      if (end && ((hire && end < hire) || (contract && end < contract))) {
        fail(400, "Employment end date must follow hire and contract start dates.");
      }
      await db.transaction(async (tx) => {
        await one(tx, "SELECT id FROM organizations WHERE id=? FOR UPDATE", actor.org_id);
        for (const [key, kind] of [[department, "Department"], [division, "Division"], [office, "Office"]]) {
          if (key && !await one(tx, "SELECT id FROM units WHERE id=? AND org_id=? AND kind=?", key, actor.org_id, kind)) {
            fail(400, `Choose a valid ${kind.toLowerCase()}.`);
          }
        }
        if (manager) {
          const supervisor = await scopedEmployee(tx, actor, manager);
          if (supervisor.id === target || !canManage(supervisor) || supervisor.status !== "Active" || supervisor.employment_status === "Ended") fail(400, "Choose an active manager.");
          const cycle = await one(tx, `WITH RECURSIVE chain(id,manager_id) AS (
            SELECT id,manager_id FROM employees WHERE id=? AND org_id=?
            UNION
            SELECT e.id,e.manager_id FROM employees e JOIN chain c ON e.id=c.manager_id WHERE e.org_id=?
          ) SELECT id FROM chain WHERE id=?`, manager, actor.org_id, actor.org_id, target);
          if (cycle) fail(400, "This reporting manager would create a reporting loop.");
        }
        const current = await one<{email:string}>(tx,"SELECT email FROM employees WHERE id=? AND org_id=? FOR UPDATE",target,actor.org_id);
        if (!current) return fail(404,"Employee record is unavailable.");
        await run(tx, `UPDATE employees SET employee_no=?,email=?,name=?,title=?,department_id=?,division_id=?,office_id=?,manager_id=?,
          country=?,jurisdiction=?,time_zone=?,employment_type=?,hire_date=?,contract_start=?,employment_end=?,
          phone=?,expected_hours=?,break_policy=?,leave_days=?,work_schedule=?,holiday_calendar=?,holiday_days=?,employment_status=? WHERE id=? AND org_id=?`,
          employeeNo, workEmail, str(data.name,"employee name",100), str(data.title,"job title",100,false), department || null, division || null,
          office || null, manager || null, officeCountry, jurisdiction,
          timeZone(data.timeZone), pick(data.employmentType,types,"employment type"), hire, contract, end,
          str(data.phone,"phone number",40,false) || null, integer(data.expectedHours,"expected weekly hours",0,80),
          pick(data.breakPolicy,["paid","unpaid"],"break policy"), data.leaveDays !== "" && data.leaveDays != null ? integer(data.leaveDays,"leave days",0,365) : null,
          str(data.workSchedule,"work schedule",180,false) || null, str(data.holidayCalendar,"holiday calendar",100,false) || null,
          data.holidayDays !== "" && data.holidayDays != null ? integer(data.holidayDays,"annual holiday entitlement",0,365) : null,
          employmentStatus,target, actor.org_id);
        if (employmentStatus==="Ended" || current.email!==workEmail) {
          const at=now();
          await run(tx,"UPDATE sessions SET ended_at=? WHERE employee_id=? AND ended_at IS NULL",at,target);
          await run(tx,"UPDATE invitations SET consumed_at=? WHERE employee_id=? AND consumed_at IS NULL",at,target);
        }
        await audit(tx, actor, "Employee profile updated", "employee", target).run();
        if (current.email!==workEmail) await audit(tx,actor,"Staff sign-in email updated","identity",target).run();
      });
      return json({ ok: true, message: "Employee profile updated." });
    }
    if (action === "status") {
      const status = pick(data.status, ["Active","Suspended"], "account status");
      if (status==="Active" && employee.employment_status==="Ended") return fail(409,"Update employment status before reactivating access.");
      await db.batch([
        stmt(db, "UPDATE employees SET status=? WHERE id=?", status, target),
        stmt(db, "UPDATE sessions SET ended_at=? WHERE employee_id=? AND ended_at IS NULL AND ?='Suspended'", now(), target, status),
        audit(db, actor, status === "Suspended" ? "Employee suspended" : "Employee reactivated", "employee", target),
      ]);
      return json({ ok: true, message: `Employee ${status.toLowerCase()}.` });
    }
    if (action === "role") {
      requireSuper(actor);
      const role = pick(data.role, roles.filter((item) => item !== "super_admin"), "staff role");
      await db.batch([stmt(db,"UPDATE employees SET role=? WHERE id=?",role,target), audit(db,actor,"Role changed","employee",target)]);
      return json({ ok:true, message:"Staff role updated." });
    }
    if (action === "invite" || (action === "email-invite" && staffReadinessEnabled())) {
      requireSuper(actor);
      if (employee.status !== "Active" || employee.employment_status==="Ended") return fail(409, "Reactivate this employee first.");
      const code = randomBytes(27).toString("base64url");
      const invitationId = id();
      await db.batch([
        stmt(db,"UPDATE invitations SET consumed_at=? WHERE employee_id=? AND consumed_at IS NULL",now(),target),
        stmt(db,"INSERT INTO invitations (id,employee_id,code_hash,expires_at) VALUES (?,?,?,?)",invitationId,target,await digest(code),new Date(Date.now()+48*3_600_000).toISOString()),
        audit(db,actor,"Access code issued","employee",target),
      ]);
      if (action === "email-invite") {
        const site = process.env.WALSHKEN_STAFF_EMAIL_ORIGIN;
        if (!site || !/^https:\/\/[a-z0-9.-]+$/i.test(site)) return json({ok:true,code,message:"Email origin is unavailable. Use this access code through your approved delivery process."});
        const status = await sendAccessCode(db,employee.email,code,invitationId,site);
        if (status==="sent") return json({ok:true,message:"Access code sent. It expires in 48 hours."});
        return json({ok:true,code,message:"Email delivery failed. This code is valid for 48 hours."});
      }
      return json({ ok: true, code, message: "A new access code is ready. It expires in 48 hours." });
    }
  }
  if (area === "organization" && action === "add") {
    requireSuper(actor);
    const target = id();
    const kind = pick(data.kind, ["Department","Division","Office"], "organization unit type");
    await db.batch([
      stmt(db,"INSERT INTO units (id,org_id,kind,name,country,region,time_zone) VALUES (?,?,?,?,?,?,?)",
        target,actor.org_id,kind,str(data.name,"name",100),kind==="Office"?country(data.country):null,
        kind==="Office"?str(data.region,"province or region",80,false):null,kind==="Office"?timeZone(data.timeZone):null),
      audit(db,actor,"Organization unit created","unit",target),
    ]);
    return json({ ok:true, message:`${kind} added.` },201);
  }
  if (area === "organization" && staffReadinessEnabled() && ["edit","delete-unused"].includes(action)) {
    requireSuper(actor);
    const target=str(data.id,"organization unit",80);
    return db.transaction(async tx=>{
      await one(tx,"SELECT id FROM organizations WHERE id=? FOR UPDATE",actor.org_id);
      const unit=await one<{kind:string;country:string|null;region:string|null;time_zone:string|null}>(tx,
        "SELECT kind,country,region,time_zone FROM units WHERE org_id=? AND id=? FOR UPDATE",actor.org_id,target);
      if(!unit)return fail(404,"Organization unit unavailable.");
      if(action==="delete-unused"){
        if(data.confirmation!=="DELETE")return fail(400,"Type DELETE to confirm removal of the unused unit.");
        if(await one(tx,`SELECT id FROM staff_action_permissions WHERE org_id=? AND scope_id=? AND scope_type IN ('department','division')
          UNION ALL SELECT id FROM employees WHERE org_id=? AND (office_id=? OR department_id=? OR division_id=?) LIMIT 1`,
          actor.org_id,target,actor.org_id,target,target,target))return fail(409,"Move employees and remove scoped rights before deleting this unit.");
        try {
          await run(tx,"DELETE FROM units WHERE org_id=? AND id=?",actor.org_id,target);
        } catch(error) {
          if((error as {code?:string}).code==="23503")return fail(409,"This unit is referenced by business records. Keep it for their history.");
          throw error;
        }
        await audit(tx,actor,"Unused organization unit removed","unit",target).run();
        return json({ok:true,message:"Unused organization unit removed."});
      }
      const name=str(data.name,"unit name",100);
      const region=unit.kind==="Office"?str(data.region,"province or region",80,false):null;
      const zone=unit.kind==="Office"?timeZone(data.timeZone):null;
      const location=unit.kind==="Office"?country(data.country):null;
      if(location && location!==unit.country && await one(tx,"SELECT id FROM employees WHERE org_id=? AND office_id=? LIMIT 1",actor.org_id,target))return fail(409,"Reassign employees to a new office before changing this office’s country.");
      await run(tx,"UPDATE units SET name=?,country=?,region=?,time_zone=? WHERE org_id=? AND id=?",name,location,region,zone,actor.org_id,target);
      await audit(tx,actor,"Organization unit updated","unit",target).run();
      return json({ok:true,message:"Organization unit updated."});
    });
  }
  if (area === "communication-policy") {
    if(!communicationAdmin(actor))return fail(403,"Administrator access is required.");
    if (action === "save") {
      await db.batch([
        stmt(db,`UPDATE organizations SET group_creation=?,group_approval=?,member_management=?,message_forwarding=?,
          message_retention_days=?,external_messaging=?,message_changes=? WHERE id=?`,
          pick(data.creation,["Super Admin","Managers","All staff"],"group creation policy"),
          pick(data.approval,["0","1"],"approval policy")==="1"?1:0,
          pick(data.members,["Super Admin","Owners","Members"],"participant management policy"),
          pick(data.forwarding,["Disabled","Managers","All staff"],"forwarding policy"),
          integer(data.retentionDays,"message retention days",0,3650),
          pick(data.external,["0","1"],"guest messaging policy")==="1"?1:0,
          pick(data.messageChanges,["Sender","Sender or Super Admin","Locked"],"message editing policy"),actor.org_id),
        audit(db,actor,"Communication policy changed","organization",actor.org_id),
      ]);
      return json({ok:true,message:"Communication policy saved."});
    }
    if (action === "apply-retention") {
      if(data.confirmation!=="ERASE") return fail(400,"Type ERASE to confirm permanent removal of expired message content.");
      await db.transaction(async (tx) => {
        await one(tx,"SELECT id FROM organizations WHERE id=? FOR UPDATE",actor.org_id);
        if(employmentEngineEnabled()&&await one(tx,`SELECT h.id FROM staff_legal_holds h WHERE h.org_id=? AND h.scope_type IN ('organization','employee','conversation') AND NOT EXISTS(SELECT 1 FROM staff_legal_hold_releases r WHERE r.hold_id=h.id) LIMIT 1`,actor.org_id))return fail(409,'Active legal holds protect messages. Review their scope before applying retention.');
        const policy=await communicationPolicy(tx,actor);
        if(!policy.message_retention_days) return fail(409,"Set a message retention period first.");
        await validateMessageRetention(tx,actor.org_id,policy.message_retention_days);
        const cutoff=retentionCutoff(policy.message_retention_days);
        await run(tx,`DELETE FROM message_reactions WHERE message_id IN (
          SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.org_id=? AND m.created_at<?
        )`,actor.org_id,cutoff);
        await run(tx,`UPDATE messages SET body='',deleted_at=?,pinned=0 WHERE deleted_at IS NULL AND created_at<?
          AND conversation_id IN (SELECT id FROM conversations WHERE org_id=?)`,now(),cutoff,actor.org_id);
        await audit(tx,actor,"Message retention applied","organization",actor.org_id).run();
      });
      return json({ok:true,message:"Expired message content cleared."});
    }
    return fail(404,"Communication policy action unavailable.");
  }

  if (area === "website") {
    requireSuper(actor);
    if (action === "inquiry") {
      const target = str(data.id, "inquiry", 80);
      const status = pick(data.status, inquiryStatuses, "request status");
      const update = str(data.update, "customer update", 2000, false);
      await db.transaction(async (tx) => {
        const result = await run(tx, "UPDATE inquiries SET status=?,customer_update=?,updated_at=? WHERE id=? AND customer_id IS NOT NULL AND kind='inquiry'",
          status, update || null, now(), target);
        if (!result.count) return fail(404, "Customer request not found.");
        await audit(tx, actor, "Customer request updated", "inquiry", target).run();
      });
      return json({ ok: true, message: "Customer request updated." });
    }
    if (action === "copy") {
      await db.batch([
        stmt(db,`INSERT INTO site_content (id,title,description,about) VALUES ('home',?,?,?)
          ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,about=excluded.about`,
          str(data.title,"homepage title",120),str(data.description,"homepage introduction",350),str(data.about,"about copy",1000)),
        audit(db,actor,"Homepage content updated","website"),
      ]);
      return json({ ok:true, message:"Homepage copy updated." });
    }
    if (action === "service") {
      const target = str(data.id,"service ID",100,false) || id();
      const icon = pick(data.icon, [...divisions.map((item) => item.icon), "services"], "service icon");
      await db.batch([
        stmt(db,`INSERT INTO services (id,name,description,icon,sort) VALUES (?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,icon=excluded.icon,sort=excluded.sort`,
          target,str(data.name,"service name",100),str(data.description,"service description",450),icon,integer(data.sort || "0","display order",0,1000)),
        audit(db,actor,"Service saved","service",target),
      ]);
      return json({ ok:true, message:"Service saved." });
    }
    if (action === "archive") {
      const target = str(data.id,"service",100);
      const archived = data.archived === "1" ? 1 : 0;
      await db.batch([stmt(db,"UPDATE services SET archived=? WHERE id=?",archived,target),audit(db,actor,archived?"Service archived":"Service restored","service",target)]);
      return json({ ok:true, message:archived?"Service archived.":"Service restored." });
    }
    if (action === "market") {
      const code = country(data.country);
      await db.batch([
        stmt(db,`INSERT INTO markets (code,enabled,contact) VALUES (?,?,?)
          ON CONFLICT(code) DO UPDATE SET enabled=excluded.enabled,contact=excluded.contact`,code,data.enabled==="1"?1:0,str(data.contact,"contact information",400,false)),
        audit(db,actor,"Country configuration updated","market",code),
      ]);
      return json({ ok:true, message:"Country settings saved." });
    }
    if (action === "availability") {
      const code = country(data.country);
      const service = str(data.service,"service",100);
      const link = destination(data.destination);
      const enabled = data.enabled === "1" ? 1 : 0;
      if (!await one(db,"SELECT id FROM services WHERE id=? AND archived=0",service)) return fail(404,"Service unavailable.");
      if (!await one(db,"SELECT code FROM markets WHERE code=?",code)) return fail(400,"Save the country settings first.");
      if (enabled && !link) return fail(400,"Set an approved service destination before publishing.");
      await db.batch([
        stmt(db,`INSERT INTO availability (id,country,service_id,enabled,destination) VALUES (?,?,?,?,?)
          ON CONFLICT(country,service_id) DO UPDATE SET enabled=excluded.enabled,destination=excluded.destination`,id(),code,service,enabled,link),
        audit(db,actor,"Service availability updated","service",service),
      ]);
      return json({ ok:true, message:"Service availability saved." });
    }
  }
  if(area==="integrations"&&action==="migrate-encryption"){
    requireSuper(actor);
    if(process.env.WALSHKEN_ALLOW_LEGACY_MIGRATION!=="1")return fail(409,"Legacy key migration is not enabled on this deployment.");
    if(!process.env.WALSHKEN_INTEGRATION_KEY||!process.env.WALSHKEN_INTEGRATION_KEY_V2)return fail(409,"Run this migration in the earlier preview after both encryption keys are configured there.");
    await throttle(db,`staff-mfa:${actor.id}`,8,300000);
    return db.transaction(async tx=>{
      const credential=await one<{password_hash:string}>(tx,"SELECT password_hash FROM credentials WHERE employee_id=? FOR UPDATE",actor.id);
      const password=str(data.password,"current password",160);
      if(!await passwordMatches(password,credential?.password_hash))return fail(401,"Current password is incorrect.");
      await verifyStaffMfa(tx,actor.id,data.code,true);
      const factors=await all<{employee_id:string;secret:string;pending_secret:string|null}>(tx,"SELECT f.employee_id,f.secret,f.pending_secret FROM staff_mfa f JOIN employees e ON e.id=f.employee_id WHERE e.org_id=? FOR UPDATE OF f",actor.org_id);
      let migrated=0;
      for(const factor of factors){
        const secret=factor.secret.startsWith("v2.")?factor.secret:await encryptSettings(`staff-mfa:${factor.employee_id}`,await decryptSettings(`staff-mfa:${factor.employee_id}`,factor.secret));
        const pending=factor.pending_secret&&!factor.pending_secret.startsWith("v2.")?await encryptSettings(`staff-mfa:${factor.employee_id}`,await decryptSettings(`staff-mfa:${factor.employee_id}`,factor.pending_secret)):factor.pending_secret;
        if(secret!==factor.secret||pending!==factor.pending_secret){await run(tx,"UPDATE staff_mfa SET secret=?,pending_secret=? WHERE employee_id=?",secret,pending,factor.employee_id);migrated++;}
      }
      for(const integration of await all<{id:string;configuration:string}>(tx,"SELECT id,configuration FROM integrations FOR UPDATE"))if(!integration.configuration.startsWith("v2."))
        await run(tx,"UPDATE integrations SET configuration=?,updated_at=? WHERE id=?",await encryptSettings(integration.id,await decryptSettings(integration.id,integration.configuration)),now(),integration.id);
      await audit(tx,actor,"Encrypted staff factors and integrations migrated without changing authenticator secrets","security migration").run();
      return json({ok:true,message:`Encryption migration completed for ${migrated} authenticator records. Passwords and authenticator codes are unchanged.`});
    });
  }
  if(area==='integrations'&&action==='test'){
    requireSuper(actor);
    await throttle(db,`integration-test:${actor.id}`,12,60000);
    const provider=providers.find(provider=>provider.id===data.provider);
    if(!provider)return fail(400,'Choose a registered integration.');
    const key=provider.id==='payroll-calculator-review'?calculatorIntegrationId():provider.id;
    const settings=await integrationSettings(db,key);
    if(!settings)return fail(409,'Save and enable this integration before testing it.');
    try{
      if(provider.id==='livekit')await verifyLiveKitConnection(settings as LiveKitSettings);
      else if(['recording-storage','document-storage-review'].includes(provider.id))await verifyRecordingStorage(settings as RecordingStorage);
      else if(provider.id==='payroll-calculator-review')await verifyCalculatorConnection(settings as CalculatorSettings);
      else if(provider.id==='malware-scanner')await verifyScanner(settings as {endpoint:string;apiKey:string});
      else return fail(409,'This provider requires a recipient-specific delivery test.');
      await audit(db,actor,'Integration connection test succeeded','integration',key).run();
      return json({ok:true,message:'Live connection test succeeded.'});
    }catch(error){
      await audit(db,actor,'Integration connection test failed','integration',key).run();
      if(error instanceof Error&&error.name==='AppError')throw error;
      return fail(502,'The live connection test failed. Review the provider account and integration settings.');
    }
  }
  if (area === "integrations" && (action === "save" || action === "disable")) {
    requireSuper(actor);
    const provider = providers.find((item) => item.id === data.provider);
    if (!provider) return fail(400,"Choose a listed integration.");
    const integrationId = provider.id==="payroll-calculator-review" ? calculatorIntegrationId() : provider.id;
    if(provider.id==="document-storage-review"){
      if(!documentsEnabled())return fail(404,"Document storage is not enabled on this deployment.");
      if(action==="save"&&(await one(db,"SELECT v.id FROM doc_versions v JOIN doc_entries d ON d.id=v.document_id WHERE d.deleted_at IS NULL LIMIT 1")||await one(db,"SELECT id FROM doc_object_cleanup LIMIT 1")))return fail(409,"Keep the current bucket while document versions exist. A planned storage migration is required to rotate its connection.");
    }
    if(provider.id==="livekit"&&await one(db,"SELECT id FROM meetings WHERE provider='livekit' AND provider_room IS NOT NULL AND ended_at IS NULL AND cancelled_at IS NULL LIMIT 1"))return fail(409,"End active LiveKit meetings before changing the connection.");
    if(provider.id==="livekit"&&await one(db,"SELECT id FROM meeting_recordings WHERE status IN ('Starting','Active','Stopping') LIMIT 1"))return fail(409,"Wait for recordings to finish before changing the LiveKit connection.");
    if(provider.id==="recording-storage"&&action==="save"&&await one(db,"SELECT id FROM meeting_recordings WHERE deleted_at IS NULL LIMIT 1"))return fail(409,"Keep the current storage connection until all retained recordings are deleted. This prevents inaccessible recordings.");
    if (action === "disable") {
      if(provider.id==="recording-storage"&&await one(db,"SELECT id FROM meeting_recordings WHERE status IN ('Starting','Active','Stopping') LIMIT 1"))return fail(409,"Stop active recordings before disabling storage.");
      const saved=await integrationSettings(db,integrationId,false);
      if(saved)await run(db,`INSERT INTO integrations(id,configuration,enabled,updated_at) VALUES(?,?,0,?)
       ON CONFLICT(id) DO UPDATE SET enabled=0,updated_at=excluded.updated_at`,integrationId,await encryptSettings(integrationId,saved),now());
      await audit(db,actor,"Integration disabled","integration",integrationId).run();
      return json({ ok:true,message:"Integration disabled." });
    }
    const settings: Record<string,string> = {};
    for (const [key, label] of provider.fields) settings[key] = str(data[key],label,400);
    if(provider.id==="livekit") {
      validateLiveKit(settings as LiveKitSettings);
      if(data.enabled==="1") await verifyLiveKitConnection(settings as LiveKitSettings);
    }
    if(provider.id==="recording-storage"||provider.id==="document-storage-review") {
      validateStorage(settings as RecordingStorage);
      if(provider.id==="document-storage-review"&&settings.bucket==="walshken-call-recordings")return fail(400,"Use a separate private document bucket.");
      if(data.enabled==="1") await verifyRecordingStorage(settings as RecordingStorage);
    }
    if(provider.id==="payroll-calculator-review"){if(!payrollEnabled())return fail(404,"Payroll is not enabled here.");validateCalculatorSettings(settings as CalculatorSettings);if(data.enabled==="1")await verifyCalculatorConnection(settings as CalculatorSettings);}
    if (provider.id==="resend") validateEmailSettings(settings as {apiKey:string;from:string});
    if (provider.id==="malware-scanner" && data.enabled==="1") await verifyScanner(settings as {endpoint:string;apiKey:string});
    const protectedValue = await encryptSettings(integrationId, settings);
    await db.batch([
      stmt(db,`INSERT INTO integrations (id,configuration,enabled,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET configuration=excluded.configuration,enabled=excluded.enabled,updated_at=excluded.updated_at`,
        integrationId,protectedValue,data.enabled==="1"?1:0,now()),
      audit(db,actor,"Integration credentials rotated","integration",integrationId),
    ]);
    return json({ ok:true,message:"Integration settings saved securely." });
  }
  if (area === "holidays" && action === "add") {
    if (!canPayroll(actor)) return fail(403,"Payroll access is required.");
    const target=id();
    await db.batch([
      stmt(db,"INSERT INTO holidays (id,org_id,name,on_date,jurisdiction,type) VALUES (?,?,?,?,?,?)",target,actor.org_id,
        str(data.name,"holiday name",100),date(data.onDate,"holiday date"),str(data.jurisdiction,"jurisdiction",30),pick(data.type,["Company observance","Statutory calendar reference"],"holiday type")),
      audit(db,actor,"Holiday recorded","holiday",target),
    ]);
    return json({ok:true,message:"Holiday added to the calendar."},201);
  }
  return fail(404, "That admin action is unavailable.");
}
