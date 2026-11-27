import { clientPortalEnabled } from "./customer";
import { notifyClient } from "./client-notifications";
import { all, canSuper, country, date, digest, fail, id, integer, json, now, one, orgId, pick, requireStaff, run, scope, str, throttle, type Actor, type Db } from "./server";
import { taskDataset } from "./tasks";
import { clientDocumentCategories } from "./client-document-types";

export const internalCaseStatuses = ["New", "Assessing", "In progress", "Waiting for client", "Ready to submit", "Submitted to authority", "Complete", "Closed"] as const;
export const visibleCaseStatuses = ["Received", "Under review", "Action required", "In progress", "Submitted", "Decision available", "Complete", "Closed"] as const;
export type CaseCustomer = { id:string; name:string; email:string };
export type ClientCase = {
  id:string; org_id:string; customer_id:string; reference:string; title:string; service:string; country:string;
  assigned_employee_id:string|null; department_id:string|null; division_id:string|null; representative_name:string;
  representative_designation:string; communication_enabled:boolean; internal_status:typeof internalCaseStatuses[number];
  client_status:typeof visibleCaseStatuses[number]; revision:number; created_at:string; submitted_at:string|null;
  application_submitted_on?:string|null; client_updated_at?:string|null; updated_at:string;
};
type CasePermissions = { sql:string; args:unknown[] };

export function requireClientCases() {
  if (!clientPortalEnabled()) return fail(404, "Client casework is unavailable.");
}

function adminCaseScope(actor: Actor): CasePermissions {
  if (canSuper(actor)) return { sql:"1=1", args:[] };
  if (actor.role !== "admin" || (!actor.department_id && !actor.division_id)) return { sql:"1=0", args:[] };
  const conditions:string[] = [];
  const args:unknown[] = [];
  for (const key of ["department_id", "division_id"] as const) {
    if (actor[key]) {
      conditions.push(`c.${key}=?`);
      args.push(actor[key]);
    }
  }
  const liveEmployeeScope = scope(actor,"e",false);
  return {
    sql:`(${conditions.join(" AND ")}) AND (c.assigned_employee_id IS NULL OR EXISTS(
      SELECT 1 FROM employees e WHERE e.id=c.assigned_employee_id AND e.org_id=c.org_id AND (${liveEmployeeScope.sql})))`,
    args:[...args,...liveEmployeeScope.args],
  };
}

function caseScope(actor: Actor): CasePermissions {
  const admin = adminCaseScope(actor);
  return { sql:`(c.assigned_employee_id=? OR (${admin.sql}))`, args:[actor.id,...admin.args] };
}

export async function clientCaseFor(db: Db, customerId: string, caseId: string, lock=false) {
  requireClientCases();
  const row = await one<ClientCase>(db,`SELECT c.* FROM client_cases c WHERE c.id=? AND c.org_id=? AND c.customer_id=?${lock?" FOR UPDATE OF c":""}`,caseId,orgId,customerId);
  if (!row) return fail(404,"This case is unavailable.");
  return row;
}

export async function staffCaseFor(db: Db, actor: Actor, caseId: string, lock=false) {
  requireClientCases();
  requireStaff(actor);
  const allowed = caseScope(actor);
  const row = await one<ClientCase>(db,`SELECT c.*,c.application_submitted_on::text AS application_submitted_on
    FROM client_cases c WHERE c.id=? AND c.org_id=? AND ${allowed.sql}${lock?" FOR UPDATE OF c":""}`,
    caseId,actor.org_id,...allowed.args);
  if (!row) return fail(404,"This case is unavailable or outside your current assignment.");
  return row;
}

export async function assertClientCaseUnheld(db:Db,caseId:string,customerId:string) {
  const row=await one(db,`SELECT h.id FROM client_case_legal_holds h LEFT JOIN client_case_hold_releases release ON release.hold_id=h.id
     WHERE h.org_id=? AND h.customer_id=? AND (h.case_id IS NULL OR h.case_id=?) AND release.hold_id IS NULL LIMIT 1`,orgId,customerId,caseId);
  if(row)return fail(409,"A legal hold protects the client account or case records.");
}

export async function canAdministerCase(db:Db, actor:Actor, row:ClientCase) {
  const allowed = adminCaseScope(actor);
  return Boolean(await one(db,`SELECT c.id FROM client_cases c WHERE c.org_id=? AND c.id=? AND (${allowed.sql})`,row.org_id,row.id,...allowed.args));
}

export async function notifyCaseStaff(db:Db, row:Pick<ClientCase,"id"|"org_id"|"assigned_employee_id"|"reference">, title:string, body:string, dedupeKey?:string) {
  if (!row.assigned_employee_id) return;
  const key = dedupeKey ? await digest(`case-notice:${row.org_id}:${row.id}:${row.assigned_employee_id}:${dedupeKey}`) : id();
  await run(db,`INSERT INTO notifications(id,employee_id,title,body,href,release_stage)
    SELECT ?,e.id,?,?,?,? FROM employees e WHERE e.id=? AND e.org_id=? AND e.status='Active' AND COALESCE(e.employment_status,'')<>'Ended' AND e.role<>'guest'
    ON CONFLICT(id) DO NOTHING`,key,title.slice(0,150),body.slice(0,500),"/staff/client-casework?case="+encodeURIComponent(row.id),taskDataset(),row.assigned_employee_id,row.org_id);
}

export async function recordCaseEvent(db:Db, row:Pick<ClientCase,"id"|"org_id">, event:string, subject:{employeeId:string}|{customerId:string}) {
  await run(db,"INSERT INTO client_case_events(id,org_id,case_id,event,employee_id,customer_id,created_at) VALUES(?,?,?,?,?,?,?)",
    id(),row.org_id,row.id,event,"employeeId" in subject?subject.employeeId:null,"customerId" in subject?subject.customerId:null,now());
}

async function caseNotice(db:Db,row:ClientCase,type:"case"|"document",title:string,body:string,dedupeKey:string) {
  await notifyClient(db,row.customer_id,{type,title,body,href:"/customer/cases?case="+encodeURIComponent(row.id),dedupeKey});
}

const visibleCaseFields = `
  c.id,c.reference,c.title,c.service,c.country,c.client_status,
  CASE WHEN rep.id IS NOT NULL THEN c.representative_name ELSE '' END AS representative_name,
  CASE WHEN rep.id IS NOT NULL THEN c.representative_designation ELSE '' END AS representative_designation,
  (c.communication_enabled AND rep.id IS NOT NULL AND c.client_status<>'Closed') AS communication_enabled,
  c.created_at,c.submitted_at,c.application_submitted_on::text AS application_submitted_on,COALESCE(c.client_updated_at,c.created_at) AS updated_at`;
const activeRepresentative = `LEFT JOIN employees rep ON rep.id=c.assigned_employee_id AND rep.org_id=c.org_id AND rep.status='Active'
  AND COALESCE(rep.employment_status,'')<>'Ended' AND rep.role<>'guest'`;

export async function clientCaseView(db:Db,customerId:string, target:string,limit=100) {
  requireClientCases();
  if (!target) return { cases:await all(db,`SELECT ${visibleCaseFields} FROM client_cases c ${activeRepresentative}
      WHERE c.org_id=? AND c.customer_id=? ORDER BY COALESCE(c.client_updated_at,c.created_at) DESC,c.id DESC LIMIT 100`,orgId,customerId) };
  const row = await one(db,`SELECT ${visibleCaseFields} FROM client_cases c ${activeRepresentative}
    WHERE c.org_id=? AND c.customer_id=? AND c.id=?`,orgId,customerId,target);
  if (!row) return fail(404,"This case is unavailable.");
  const [updates,requests,messages] = await Promise.all([
    all(db,`SELECT id,title,body,proposed_status,submission_date::text AS submission_date,decided_at AS published_at
      FROM client_case_updates WHERE org_id=? AND case_id=? AND decision='Published' ORDER BY decided_at DESC,id DESC LIMIT ?`,orgId,target,limit),
    all(db,`SELECT id,title,instructions,due_on::text AS due_on,status,expected_category,created_at,updated_at FROM client_case_document_requests
      WHERE org_id=? AND case_id=? ORDER BY due_on,id LIMIT ?`,orgId,target,limit),
    all(db,`SELECT id,direction,display_name,body,created_at FROM
      (SELECT id,direction,display_name,body,created_at FROM client_case_messages WHERE org_id=? AND case_id=? ORDER BY created_at DESC,id DESC LIMIT ?)
      m ORDER BY created_at,id`,orgId,target,limit),
  ]);
  return {case:row,updates,requests,messages};
}

export async function staffCaseView(db:Db,actor:Actor,target:string,search="") {
  requireClientCases();
  requireStaff(actor);
  if (!target) {
    const allowed = caseScope(actor), query=str(search,"case search",100,false).toLowerCase();
    const [cases,registrations] = await Promise.all([
      all(db,`SELECT c.id,c.reference,c.title,c.service,c.country,c.assigned_employee_id,c.representative_name,
        c.internal_status,c.client_status,c.revision,c.created_at,c.updated_at,client.name AS customer_name
        FROM client_cases c JOIN customers client ON client.id=c.customer_id WHERE c.org_id=? AND ${allowed.sql}
          AND (?='' OR strpos(lower(concat_ws(' ',c.reference,c.title,c.service,client.name)),?)>0)
        ORDER BY CASE WHEN c.assigned_employee_id IS NULL THEN 0 ELSE 1 END,c.updated_at DESC,c.id LIMIT 100`,actor.org_id,...allowed.args,query,query),
      canSuper(actor) ? all(db,`SELECT customer.id,customer.name,customer.email,customer.created_at FROM customers customer
        WHERE (?='' OR strpos(lower(concat_ws(' ',customer.name,customer.email)),?)>0)
        ORDER BY customer.created_at DESC,customer.id LIMIT 50`,query,query) : [],
    ]);
    return {cases,registrations,canCreate:canSuper(actor)};
  }
  const row = await staffCaseFor(db,actor,target);
  const admin = await canAdministerCase(db,actor,row), allowed=scope(actor,"e");
  const [customer, employees, assignments, notes, requests, updates, messages, events] = await Promise.all([
    one(db,"SELECT id,name,email FROM customers WHERE id=?",row.customer_id),
    admin ? all(db,`SELECT e.id,e.name,e.employee_no FROM employees e WHERE e.org_id=? AND e.role<>'guest' AND e.status='Active'
      AND COALESCE(e.employment_status,'')<>'Ended' AND (${allowed.sql}) ORDER BY e.name,e.id LIMIT 500`,row.org_id,...allowed.args) : [],
    admin ? all(db,`SELECT a.id,a.assigned_at,a.ended_at,e.name FROM client_case_assignments a
      JOIN employees e ON e.id=a.employee_id AND e.org_id=a.org_id WHERE a.org_id=? AND a.case_id=? ORDER BY a.assigned_at DESC,a.id LIMIT 100`,row.org_id,target) : [],
    all(db,`SELECT n.id,n.body,n.created_at,e.name AS author FROM client_case_notes n JOIN employees e ON e.id=n.employee_id AND e.org_id=n.org_id
      WHERE n.org_id=? AND n.case_id=? ORDER BY n.created_at DESC,n.id DESC LIMIT 100`,row.org_id,target),
    all(db,`SELECT id,title,instructions,due_on::text AS due_on,status,expected_category,created_at,updated_at FROM client_case_document_requests
      WHERE org_id=? AND case_id=? ORDER BY due_on,id LIMIT 100`,row.org_id,target),
    all(db,`SELECT u.id,u.title,u.body,u.proposed_status,u.submission_date::text AS submission_date,u.created_at,u.created_by,u.decision,u.review_note,u.decided_at,e.name AS author
      FROM client_case_updates u JOIN employees e ON e.id=u.created_by AND e.org_id=u.org_id
      WHERE u.org_id=? AND u.case_id=? ORDER BY u.created_at DESC,u.id DESC LIMIT 100`,row.org_id,target),
    all(db,`SELECT id,direction,display_name,body,created_at FROM
      (SELECT id,direction,display_name,body,created_at FROM client_case_messages WHERE org_id=? AND case_id=? AND endpoint_id IS NULL ORDER BY created_at DESC,id DESC LIMIT 100)
      m ORDER BY created_at,id`,row.org_id,target),
    all(db,`SELECT history.id,history.event,history.created_at,COALESCE(e.name,customer.name) AS actor
      FROM client_case_events history LEFT JOIN employees e ON e.id=history.employee_id AND e.org_id=history.org_id
      LEFT JOIN customers customer ON customer.id=history.customer_id WHERE history.org_id=? AND history.case_id=?
      ORDER BY history.created_at DESC,history.id DESC LIMIT 100`,row.org_id,target),
  ]);
  return {case:row,customer,employees,assignments,notes,requests,updates,messages,events,canManage:admin,canPrivacy:canSuper(actor),viewer:actor.id};
}

async function newCase(db:Db, customer:CaseCustomer, data:Record<string,unknown>, employee?:Actor) {
  const customerId=customer.id,organization=employee?.org_id??orgId;
  const title=str(data.title,"case title",160),service=str(data.service,"immigration service",150), market=country(data.country);
  const reason=str(data.message,"case background",5000,false), requestedId=str(data.requestId,"request reference",36,false);
  if (requestedId&&!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestedId)) return fail(400,"Refresh before submitting the case.");
  const caseId=requestedId.toLowerCase()||id(), reference="WAL-"+id().replaceAll("-","").slice(0,12).toUpperCase(), at=now();
  const saved=await run(db,`INSERT INTO client_cases(id,org_id,customer_id,reference,title,service,country,created_at,submitted_at,client_updated_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,caseId,organization,customerId,reference,title,service,market,at,employee?null:at,at,at);
  if (!saved.count) {
    const row=await one<ClientCase>(db,"SELECT * FROM client_cases WHERE id=? AND org_id=? AND customer_id=? AND title=? AND service=? AND country=?",caseId,organization,customerId,title,service,market);
    if(!row)return fail(409,"The submission already exists. Open a new case to continue.");
    return json({ok:true,id:row.id,reference:row.reference,message:"Case received."});
  }
  const row=await one<ClientCase>(db,"SELECT * FROM client_cases WHERE id=?",caseId);
  if(!row)return fail(500,"The case could not be loaded.");
  if(reason) {
    if(employee) await run(db,"INSERT INTO client_case_notes(id,org_id,case_id,employee_id,body,created_at) VALUES(?,?,?,?,?,?)",id(),organization,caseId,employee.id,reason,at);
    else await run(db,`INSERT INTO client_case_messages(id,org_id,case_id,direction,customer_id,display_name,body,created_at)
      VALUES(?,?,?,'Client',?,?,?,?)`,id(),organization,caseId,customerId,customer.name,reason,at);
  }
  await recordCaseEvent(db,row,employee?"Staff opened a case":"Client submitted a case",employee?{employeeId:employee.id}:{customerId});
  await caseNotice(db,row,"case","Case received","Your immigration case has been received.",caseId+":received");
  if (!employee) {
    await run(db,`INSERT INTO notifications(id,employee_id,title,body,href,release_stage)
      SELECT ?||':'||e.id,e.id,'New client case','Review the new case in the client casework queue.',?,?
      FROM employees e WHERE e.org_id=? AND e.role='super_admin' AND e.status='Active' AND COALESCE(e.employment_status,'')<>'Ended'
      ON CONFLICT(id) DO NOTHING`,await digest("case-inbox:"+caseId),"/staff/client-casework?case="+encodeURIComponent(caseId),taskDataset(),organization);
  }
  return json({ok:true,id:row.id,reference,message:"Case received."},201);
}

async function assertCommunication(db:Db,row:ClientCase) {
  const active=row.assigned_employee_id&&await one(db,`SELECT id FROM employees WHERE id=? AND org_id=? AND status='Active'
    AND COALESCE(employment_status,'')<>'Ended' AND role<>'guest'`,row.assigned_employee_id,row.org_id);
  if (!row.communication_enabled || row.client_status==="Closed" || !active) return fail(409,"Messaging requires an active representative and an open communication channel.");
}

export async function customerCaseAction(db:Db,customer:CaseCustomer,action:string,data:Record<string,unknown>) {
  requireClientCases();
  await throttle(db,"client-case:"+customer.id,60,60_000);
  if (action==="submit") return db.transaction(tx=>newCase(tx,customer,data));
  if (action!=="message") return fail(404,"This case action is unavailable.");
  return db.transaction(async tx=>{
    const row=await clientCaseFor(tx,customer.id,str(data.case,"case",80),true);
    await assertCommunication(tx,row);
    const key=id(),body=str(data.body,"message",4000);
    await run(tx,`INSERT INTO client_case_messages(id,org_id,case_id,direction,customer_id,display_name,body,created_at)
      VALUES(?,?,?,'Client',?,?,?,?)`,key,row.org_id,row.id,customer.id,customer.name,body,now());
    await notifyCaseStaff(tx,row,"Client case message","Open the assigned case to read a new client message.",key);
    await run(tx,"UPDATE client_cases SET updated_at=?,client_updated_at=? WHERE org_id=? AND id=?",now(),now(),row.org_id,row.id);
    await recordCaseEvent(tx,row,"Client message sent",{customerId:customer.id});
    return json({ok:true,message:"Message sent."},201);
  });
}

export async function staffCaseAction(db:Db,actor:Actor,action:string,data:Record<string,unknown>) {
  requireClientCases();
  requireStaff(actor);
  await throttle(db,"staff-client-case:"+actor.id,90,60_000);
  const response=await db.transaction(async tx=>{
    if (action==="create") {
      if (!canSuper(actor)) return fail(403,"Organization case administration is required to open a case from the registration queue.");
      const account=await one<CaseCustomer>(tx,"SELECT id,name,email FROM customers WHERE id=?",str(data.customer,"client account",80));
      if(!account)return fail(404,"This client registration is unavailable.");
      return newCase(tx,account,data,actor);
    }
    const row=await staffCaseFor(tx,actor,str(data.case,"case",80),true);
    const change=action!=="message"&&action!=="note";
    if(change&&integer(data.revision,"case revision",1,2147483646)!==row.revision)return fail(409,"This case has changed. Refresh before continuing.");
    const admin=await canAdministerCase(tx,actor,row),at=now(),key=id();
    const staff={employeeId:actor.id};
    let event:string, visibleChange=false;
    if (action==="assign"||action==="client-access") {
      if(!admin)return fail(403,"Scoped case administration is required.");
      visibleChange=true;
      if(action==="client-access"){
        if(typeof data.enabled!=="boolean")return fail(400,"Choose whether client communication is permitted.");
        await run(tx,"UPDATE client_cases SET communication_enabled=? WHERE id=? AND org_id=?",data.enabled,row.id,row.org_id);
        event=data.enabled?"Client communication enabled":"Client communication disabled";
      }else{
        const selected=str(data.employee,"representative",80,false),allowed=scope(actor,"e");
        const employee=selected?await one<Actor>(tx,`SELECT e.* FROM employees e WHERE e.org_id=? AND e.id=? AND e.role<>'guest'
          AND e.status='Active' AND COALESCE(e.employment_status,'')<>'Ended' AND (${allowed.sql})`,row.org_id,selected,...allowed.args):null;
        if(selected&&!employee)return fail(404,"Choose an active representative in your scope.");
        const alias=employee?str(data.representativeName,"company display name",100):"";
        const designation=employee?str(data.designation,"professional designation",100,false):"";
        if(/@|\+?\d[\d\s().-]{6,}\d/.test(alias+" "+designation))return fail(400,"Use a company-approved name and designation without personal contact details.");
        if (row.assigned_employee_id!==(employee?.id??null)) {
          await run(tx,"UPDATE client_case_assignments SET ended_at=?,ended_by=? WHERE org_id=? AND case_id=? AND ended_at IS NULL",at,actor.id,row.org_id,row.id);
          if(employee)await run(tx,`INSERT INTO client_case_assignments(id,org_id,case_id,employee_id,assigned_by,assigned_at)
            VALUES(?,?,?,?,?,?)`,key,row.org_id,row.id,employee.id,actor.id,at);
        }
        await run(tx,`UPDATE client_cases SET assigned_employee_id=?,department_id=?,division_id=?,representative_name=?,representative_designation=?
          WHERE org_id=? AND id=?`,employee?.id??null,employee?.department_id??row.department_id,employee?.division_id??row.division_id,alias,designation,row.org_id,row.id);
        if(employee){
          await caseNotice(tx,row,"case","Your case representative was updated","Open your case to see your company representative.",row.id+":assignment:"+row.revision);
          await notifyCaseStaff(tx,{...row,assigned_employee_id:employee.id},"Client case assigned","Open your casework queue to review the assignment.",key);
        }
        event=employee?"Case representative assigned":"Case representative removed";
      }
    } else if (action==="internal-status"){
      await run(tx,"UPDATE client_cases SET internal_status=? WHERE org_id=? AND id=?",pick(data.status,internalCaseStatuses,"internal stage"),row.org_id,row.id);
      event="Internal case stage updated";
    } else if (action==="note"){
      await run(tx,"INSERT INTO client_case_notes(id,org_id,case_id,employee_id,body,created_at) VALUES(?,?,?,?,?,?)",key,row.org_id,row.id,actor.id,str(data.body,"internal note",5000),at);
      event="An internal case note was added";
    } else if (action==="message"){
      await assertCommunication(tx,row);
      visibleChange=true;
      const identity=row.assigned_employee_id===actor.id?row.representative_name:"Walshken Client Services";
      await run(tx,`INSERT INTO client_case_messages(id,org_id,case_id,direction,employee_id,display_name,body,created_at)
        VALUES(?,?,?,'Company',?,?,?,?)`,key,row.org_id,row.id,actor.id,identity,str(data.body,"message",4000),at);
      await caseNotice(tx,row,"case","New case message","Open your portal to read the message from Walshken.",key);
      event="Client-visible message sent";
    } else if (action==="propose"){
      if (row.client_status==="Closed") return fail(409,"Closed cases do not accept new progress proposals.");
      const proposed=data.status?pick(data.status,visibleCaseStatuses,"client-visible stage"):null;
      await run(tx,`INSERT INTO client_case_updates(id,org_id,case_id,title,body,proposed_status,submission_date,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,key,row.org_id,row.id,str(data.title,"update title",150),str(data.body,"client-visible wording",5000),proposed,date(data.submissionDate,"submission date",false),actor.id,at);
      event="Client update sent for review";
    } else if (action==="review"){
      if (!admin) return fail(403,"Scoped case administration is required to publish an update.");
      const update=await one<{id:string;created_by:string;decision:string;proposed_status:string|null;submission_date:string|null}>(tx,`SELECT id,created_by,decision,proposed_status,submission_date::text AS submission_date
        FROM client_case_updates WHERE org_id=? AND case_id=? AND id=? FOR UPDATE`,row.org_id,row.id,str(data.update,"proposed update",80));
      if (!update||update.decision!=="Pending") return fail(409,"This update is no longer awaiting review.");
      if (update.created_by===actor.id) return fail(403,"A different authorized administrator must review the proposal.");
      const decision=pick(data.decision,["Published","Returned"] as const,"publication decision");
      await run(tx,`UPDATE client_case_updates SET decision=?,decided_by=?,decided_at=?,review_note=? WHERE org_id=? AND id=?`,
        decision,actor.id,at,str(data.reviewNote,"review note",1500),row.org_id,update.id);
      if (decision==="Published"){
        visibleChange=true;
        if(update.proposed_status)await run(tx,"UPDATE client_cases SET client_status=? WHERE org_id=? AND id=?",update.proposed_status,row.org_id,row.id);
        if(update.submission_date)await run(tx,"UPDATE client_cases SET application_submitted_on=? WHERE org_id=? AND id=?",update.submission_date,row.org_id,row.id);
        await caseNotice(tx,row,"case","Case progress updated","A reviewed case update is available in your portal.",update.id+":published");
      }
      event=decision==="Published"?"Client case update published":"Client case update returned to staff";
    } else if (action==="request-document"||action==="edit-document"){
      if(row.client_status==="Closed")return fail(409,"Closed cases do not accept document requests.");
      visibleChange=true;
      const title=str(data.title,"requirement",150),instructions=str(data.instructions,"document instructions",2000),due=date(data.due,"deadline");
      const expected=data.expectedCategory===""||data.expectedCategory==null?null:pick(data.expectedCategory,clientDocumentCategories,"document category");
      if(action==="request-document"){
        await run(tx,`INSERT INTO client_case_document_requests(id,org_id,case_id,title,instructions,due_on,expected_category,created_by,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`,key,row.org_id,row.id,title,instructions,due,expected,actor.id,at,at);
        event="Client document request opened";
      }else{
        const result=await run(tx,`UPDATE client_case_document_requests SET title=?,instructions=?,due_on=?,updated_at=?,
          expected_category=CASE WHEN ?::boolean THEN ?::text ELSE expected_category END
          WHERE org_id=? AND case_id=? AND id=? AND status IN('Open','Replacement requested')`,
        title,instructions,due,at,data.expectedCategory!==undefined,expected,row.org_id,row.id,str(data.request,"document request",80));
        if(!result.count)return fail(409,"Only requirements awaiting the client can be edited.");
        event="Client document request updated";
      }
      await caseNotice(tx,row,"document",action==="request-document"?"New document requirement":"Document requirement updated",
        "Open your portal to review the requested document and deadline.",key+":requested");
    } else if (action==="cancel-document"){
      const result=await run(tx,`UPDATE client_case_document_requests SET status='Cancelled',updated_at=? WHERE org_id=? AND case_id=? AND id=?
        AND status IN('Open','Replacement requested')`,at,row.org_id,row.id,str(data.request,"document request",80));
      if(!result.count)return fail(409,"Only open requests awaiting the client can be cancelled.");
      visibleChange=true;
      event="Client document request cancelled";
    } else if (action==="case-details"){
      if(!admin)return fail(403,"Scoped case administration is required.");
      if(row.client_status==="Closed")return fail(409,"Reopen the case before editing its details.");
      const title=str(data.title,"case title",160),service=str(data.service,"immigration service",150),market=country(data.country);
      await run(tx,"UPDATE client_cases SET title=?,service=?,country=? WHERE org_id=? AND id=?",title,service,market,row.org_id,row.id);
      visibleChange=true;
      event="Client case details updated";
    } else return fail(404,"This case action is unavailable.");
    await run(tx,`UPDATE client_cases SET revision=revision+?,updated_at=?,client_updated_at=CASE WHEN ? THEN ? ELSE client_updated_at END
      WHERE org_id=? AND id=?`,change?1:0,at,visibleChange,at,row.org_id,row.id);
    await recordCaseEvent(tx,row,event,staff);
    return json({ok:true,message:event+"."});
  });
  if(["assign","client-access","review"].includes(action)){
    try {
      const {refreshClientCallCaseAccess}=await import("./client-calls");
      await refreshClientCallCaseAccess(db,actor.org_id,str(data.case,"case",80));
    } catch { console.error("Client call refresh deferred after an authorized case change"); }
  }
  return response;
}
