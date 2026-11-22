import { randomBytes } from "node:crypto";
import { inquiryStatuses } from "./customer-status";
import { divisions, providers, roles } from "./catalog";
import { communicationAdmin, communicationPolicy, retentionCutoff } from "./collaboration";
import { verifyDailyConnection } from "./meetings";
import {
  all, audit, canManage, canPayroll, canSuper, country, date, destination, digest, email, encryptSettings,
  fail, id, integer, json, now, one, pick, requireSuper, run, scopedEmployee, stmt, str, timeZone, type Actor, type Db,
} from "./server";

const employmentStatuses = ["Active", "On leave", "Ended"] as const;
const types = ["Full-time", "Part-time", "Fixed-term", "Contractor"] as const;

export async function adminAction(db: Db, actor: Actor, area: string, action: string, data: Record<string, unknown>) {
  if (area === "employees") {
    if (!canManage(actor) || actor.role === "manager") return fail(403, "Employee administration access is required.");
    if (action === "add") {
      requireSuper(actor);
      const target = id();
      const role = pick(data.role, roles.filter((role) => role !== "super_admin"), "staff role");
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
      const code = randomBytes(27).toString("base64url");
      await db.batch([
        stmt(db, `INSERT INTO employees
          (id,org_id,employee_no,name,email,role,title,department_id,division_id,office_id,manager_id,country,jurisdiction,time_zone,
          employment_type,hire_date,contract_start,phone,expected_hours,break_policy,leave_days)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, target, actor.org_id, str(data.employeeNo,"employee ID",40),
          str(data.name,"employee name",100), email(data.email), role, str(data.title,"job title",100,false), department || null,
          division || null, office || null, manager || null, country(data.country), str(data.jurisdiction,"jurisdiction",30),
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
    const employee = await scopedEmployee(db, actor, target, editingOwnAdmin);
    if (employee.role === "super_admin" && !editingOwnAdmin) return fail(403, "This administrator is protected.");
    if (action === "edit") {
      requireSuper(actor);
      const employeeNo = data.employeeNo === undefined ? employee.employee_no : str(data.employeeNo,"employee ID",40);
      const workEmail = data.email === undefined ? employee.email : email(data.email);
      const department = str(data.department, "department", 80, false);
      const division = str(data.division, "division", 80, false);
      const office = str(data.office, "office", 80, false);
      const manager = str(data.manager, "manager", 80, false);
      const hire = date(data.hireDate, "hire date", false);
      const contract = date(data.contractStart, "contract start date", false);
      const end = date(data.employmentEnd, "employment end date", false);
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
          office || null, manager || null, country(data.country), str(data.jurisdiction,"jurisdiction",30),
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
    if (action === "invite") {
      requireSuper(actor);
      if (employee.status !== "Active" || employee.employment_status==="Ended") return fail(409, "Reactivate this employee first.");
      const code = randomBytes(27).toString("base64url");
      await db.batch([
        stmt(db,"UPDATE invitations SET consumed_at=? WHERE employee_id=? AND consumed_at IS NULL",now(),target),
        stmt(db,"INSERT INTO invitations (id,employee_id,code_hash,expires_at) VALUES (?,?,?,?)",id(),target,await digest(code),new Date(Date.now()+48*3_600_000).toISOString()),
        audit(db,actor,"Access code issued","employee",target),
      ]);
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
        const policy=await communicationPolicy(tx,actor);
        if(!policy.message_retention_days) return fail(409,"Set a message retention period first.");
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
  if (area === "integrations" && (action === "save" || action === "disable")) {
    requireSuper(actor);
    const provider = providers.find((item) => item.id === data.provider);
    if (!provider) return fail(400,"Choose a listed integration.");
    if (action === "disable") {
      await db.batch([stmt(db,"UPDATE integrations SET enabled=0,updated_at=? WHERE id=?",now(),provider.id),audit(db,actor,"Integration disabled","integration",provider.id)]);
      return json({ ok:true,message:"Integration disabled." });
    }
    const settings: Record<string,string> = {};
    for (const [key, label] of provider.fields) settings[key] = str(data[key],label,400);
    if (provider.id === "daily") {
      if(!/^[a-z0-9][a-z0-9-]{1,60}$/i.test(settings.domain)) return fail(400,"Enter the Daily subdomain without .daily.co.");
      if(data.enabled==="1") await verifyDailyConnection({domain:settings.domain,apiKey:settings.apiKey});
    }
    const protectedValue = await encryptSettings(provider.id, settings);
    await db.batch([
      stmt(db,`INSERT INTO integrations (id,configuration,enabled,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET configuration=excluded.configuration,enabled=excluded.enabled,updated_at=excluded.updated_at`,
        provider.id,protectedValue,data.enabled==="1"?1:0,now()),
      audit(db,actor,"Integration credentials rotated","integration",provider.id),
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
