import { clientCaseFor, notifyCaseStaff, recordCaseEvent, staffCaseFor, type ClientCase } from "./client-cases";
import { notifyClient } from "./client-notifications";
import { taskDataset } from "./tasks";
import { all, canSuper, digest, fail, json, now, one, orgId, run, str, throttle, type Actor, type Db } from "./server";
import type { ClientActor } from "./customer";

type Viewer = { side:"client"; actor:ClientActor } | { side:"staff"; actor:Actor };
type Endpoint = {id:string;name:string;kind:"Office"|"Support";employee_id:string;enabled:boolean;available:boolean};
type Scope = { caseRow:ClientCase; endpoint:Endpoint|null; writable:boolean };
type LastMessage = {id:string;created_at:string};
const direction = (viewer: Viewer) => viewer.side === "client" ? "Client" : "Company";
const organization = (viewer: Viewer) => viewer.side === "client" ? orgId : viewer.actor.org_id;
const active = (alias:string) => `${alias}.status='Active' AND COALESCE(${alias}.employment_status,'')<>'Ended' AND ${alias}.role<>'guest'`;
const endpointFilter = "m.endpoint_id IS NOT DISTINCT FROM ?::text";
const requiredKey = (value:unknown) => {
  const result = str(value,"message reference",36);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result))return fail(400,"A message needs a valid submission reference.");
  return result;
};

async function scopeConversation(db: Db, viewer: Viewer, caseId: string, endpointId: string, lock = false): Promise<Scope> {
  const org = organization(viewer);
  let row:ClientCase|null;
  if(viewer.side === "client") row=await clientCaseFor(db,viewer.actor.id,caseId,lock);
  else if(!endpointId) row=await staffCaseFor(db,viewer.actor,caseId,lock);
  else row=await one<ClientCase>(db,`SELECT c.* FROM client_cases c WHERE c.org_id=? AND c.id=?${lock?" FOR UPDATE OF c":""}`,org,caseId);
  if(!row)return fail(404,"This conversation is unavailable.");

  const caseOpen=row.communication_enabled && row.client_status!=="Closed";
  if(!endpointId){
    const available=row.assigned_employee_id && await one(db,`SELECT e.id FROM employees e WHERE e.id=? AND e.org_id=? AND ${active("e")}`,row.assigned_employee_id,org);
    return {caseRow:row, endpoint:null, writable:caseOpen && Boolean(available)};
  }

  const endpoint = await one<Endpoint>(db,`SELECT r.id,r.name,r.kind,r.employee_id,r.enabled,(e.id IS NOT NULL) AS available
    FROM client_call_endpoints r LEFT JOIN employees e ON e.id=r.employee_id AND e.org_id=r.org_id AND ${active("e")}
    WHERE r.org_id=? AND r.id=?${lock?" FOR SHARE OF r":""}`,org,endpointId);
  if(!endpoint)return fail(404,"This office conversation is unavailable.");

  if(viewer.side==="client"&&(!endpoint.enabled||!row.communication_enabled)&&!await one(db,
    "SELECT id FROM client_case_messages WHERE org_id=? AND case_id=? AND endpoint_id=? LIMIT 1",org,row.id,endpoint.id))
    return fail(404,"This office conversation is unavailable.");
  if(viewer.side === "staff" && !canSuper(viewer.actor)){
    if(endpoint.employee_id!==viewer.actor.id || !endpoint.enabled || !endpoint.available || !row.communication_enabled)
      return fail(404,"This office conversation is unavailable.");
    if(!await one(db,`SELECT id FROM client_case_messages WHERE org_id=? AND case_id=? AND endpoint_id=? LIMIT 1`,org,row.id,endpoint.id))
      return fail(404,"This office conversation is unavailable.");
  }
  return {caseRow:row,endpoint,writable:caseOpen && endpoint.enabled && endpoint.available &&
    (viewer.side==="client" || endpoint.employee_id===viewer.actor.id)};
}

export async function officeConversationInbox(db:Db,actor:Actor) {
  return all(db,`SELECT c.id AS case_id,c.reference,customer.name AS client_name,desk.id AS endpoint_id,desk.name AS office_name,
      MAX(m.created_at) AS latest_at,
      COUNT(*) FILTER(WHERE m.direction='Client' AND receipt.message_id IS NULL)::int AS unread
    FROM client_case_messages m
    JOIN client_call_endpoints desk ON desk.org_id=m.org_id AND desk.id=m.endpoint_id
    JOIN client_cases c ON c.org_id=m.org_id AND c.id=m.case_id
    JOIN customers customer ON customer.id=c.customer_id
    LEFT JOIN client_case_message_receipts receipt ON receipt.message_id=m.id AND receipt.reader_side='Company' AND receipt.reader_id=?
    WHERE m.org_id=? AND ((desk.enabled AND desk.employee_id=? AND c.communication_enabled) OR ?::boolean)
    GROUP BY c.id,c.reference,customer.name,desk.id,desk.name
    ORDER BY MAX(m.created_at) DESC,c.id,desk.id LIMIT 100`,actor.id,actor.org_id,actor.id,canSuper(actor));
}

async function clientThreadChoices(db:Db,row:ClientCase) {
  return all<{endpoint:string;name:string;kind:string;available:boolean;unread:number}>(db,`WITH unread AS (
      SELECT m.endpoint_id,COUNT(*)::int AS unread FROM client_case_messages m
      LEFT JOIN client_case_message_receipts receipt ON receipt.message_id=m.id AND receipt.reader_side='Client' AND receipt.reader_id=?
      WHERE m.org_id=? AND m.case_id=? AND m.direction='Company' AND receipt.message_id IS NULL GROUP BY m.endpoint_id
    )
    SELECT '' AS endpoint,CASE WHEN c.representative_name='' THEN 'Case representative' ELSE c.representative_name END AS name,
      'Representative' AS kind,(c.communication_enabled AND c.client_status<>'Closed' AND staff.id IS NOT NULL) AS available,COALESCE(u.unread,0) AS unread
    FROM client_cases c LEFT JOIN employees staff ON staff.id=c.assigned_employee_id AND staff.org_id=c.org_id AND ${active("staff")}
    LEFT JOIN unread u ON u.endpoint_id IS NULL WHERE c.org_id=? AND c.id=?
    UNION ALL
    SELECT r.id,r.name,r.kind,(r.enabled AND staff.id IS NOT NULL AND ?::boolean) AS available,COALESCE(u.unread,0) AS unread
    FROM client_call_endpoints r LEFT JOIN employees staff ON staff.id=r.employee_id AND staff.org_id=r.org_id AND ${active("staff")}
    LEFT JOIN unread u ON u.endpoint_id=r.id
    WHERE r.org_id=? AND ((r.enabled AND ?::boolean) OR EXISTS (SELECT 1 FROM client_case_messages previous
      WHERE previous.org_id=r.org_id AND previous.case_id=? AND previous.endpoint_id=r.id))
    ORDER BY kind,name`,row.customer_id,row.org_id,row.id,row.org_id,row.id,
    row.communication_enabled&&row.client_status!=="Closed",row.org_id,row.communication_enabled,row.id);
}

export async function conversationView(db:Db,viewer:Viewer,caseId:string,endpointId:string,beforeId:string) {
  const {caseRow:row,endpoint,writable}=await scopeConversation(db,viewer,caseId,endpointId);
  const before=beforeId?await one<LastMessage>(db,`SELECT m.id,m.created_at FROM client_case_messages m
    WHERE m.org_id=? AND m.case_id=? AND ${endpointFilter} AND m.id=?`,row.org_id,row.id,endpoint?.id??null,beforeId):null;
  if(beforeId&&!before)return fail(404,"This message page is unavailable.");
  const side=direction(viewer), inverse=side==="Client"?"Company":"Client";
  const [items,unread,threads]=await Promise.all([
    all<Record<string,unknown>>(db,`SELECT m.id,m.direction,m.display_name,m.body,m.created_at,
        own.read_at AS viewer_read_at,other.read_at AS recipient_read_at,
        v.id AS version_id,v.filename,v.version,v.page_count,v.document_id,
        (m.attachment_version_id IS NOT NULL AND v.id IS NULL) AS attachment_unavailable
      FROM client_case_messages m
      LEFT JOIN client_case_message_receipts own ON own.message_id=m.id AND own.reader_side=? AND own.reader_id=?
      LEFT JOIN LATERAL (SELECT MIN(e.read_at) AS read_at FROM client_case_message_receipts e
        WHERE e.message_id=m.id AND e.reader_side=?) other ON m.direction=?
      LEFT JOIN client_document_versions v ON v.id=m.attachment_version_id AND v.org_id=m.org_id AND v.case_id=m.case_id
        AND EXISTS (SELECT 1 FROM client_documents d WHERE d.id=v.document_id AND d.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM client_document_disposals d WHERE d.document_id=v.document_id AND d.status IN ('Approved','Disposed'))
      WHERE m.org_id=? AND m.case_id=? AND ${endpointFilter}
        AND (?::text IS NULL OR (m.created_at,m.id)<(?::text,?::text))
      ORDER BY m.created_at DESC,m.id DESC LIMIT 51`,side,viewer.actor.id,inverse,side,row.org_id,row.id,endpoint?.id??null,
    before?.created_at??null,before?.created_at??null,before?.id??null),
    one<{count:number}>(db,`SELECT COUNT(*)::int AS count FROM client_case_messages m
      LEFT JOIN client_case_message_receipts receipt ON receipt.message_id=m.id AND receipt.reader_side=? AND receipt.reader_id=?
      WHERE m.org_id=? AND m.case_id=? AND ${endpointFilter} AND m.direction<>? AND receipt.message_id IS NULL`,
    side,viewer.actor.id,row.org_id,row.id,endpoint?.id??null,side),
    viewer.side==="client"?clientThreadChoices(db,row):[],
  ]);
  return {messages:items.slice(0,50).reverse(),before:items.length>50?items[49].id:null,unread:unread?.count??0,threads,writable,
    endpoint:endpoint?.id??"",label:endpoint?.name || row.representative_name || "Case representative"};
}

async function attachmentVersionFor(db:Db,row:ClientCase,version:string) {
  return one(db,`SELECT v.id FROM client_document_versions v JOIN client_documents d ON d.id=v.document_id AND d.org_id=v.org_id
    WHERE v.org_id=? AND v.case_id=? AND v.customer_id=? AND v.id=? AND d.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM client_document_disposals p WHERE p.document_id=d.id AND p.status IN('Approved','Disposed'))`,row.org_id,row.id,row.customer_id,version);
}

async function notifyOffice(db:Db,row:ClientCase,endpoint:Endpoint,reference:string) {
  const href="/staff/client-casework?"+new URLSearchParams({supportCase:row.id,supportEndpoint:endpoint.id}).toString();
  const token=await digest(`office-message:${row.id}:${endpoint.id}:${reference}`);
  await run(db,`INSERT INTO notifications(id,employee_id,title,body,href,release_stage)
    SELECT ?,e.id,'New office message','Open the office conversation to read a client message.',?,? FROM employees e
    WHERE e.org_id=? AND e.id=? AND ${active("e")} ON CONFLICT(id) DO NOTHING`,token,href,taskDataset(),row.org_id,endpoint.employee_id);
}

export async function conversationAction(db:Db,viewer:Viewer,data:Record<string,unknown>) {
  const action=str(data.action,"message action",12),caseId=str(data.case,"case",80),endpointId=str(data.endpoint,"office",80,false);
  if(action!=="send"&&action!=="read")return fail(404,"This message action is unavailable.");
  await throttle(db,`client-conversation:${viewer.side}:${viewer.actor.id}`,120,60_000);

  return db.transaction(async tx=>{
    const {caseRow:row,endpoint,writable}=await scopeConversation(tx,viewer,caseId,endpointId,action==="send");
    const side=direction(viewer);
    if(action==="read"){
      if(!Array.isArray(data.messages)||!data.messages.length||data.messages.length>50)return fail(400,"Choose up to 50 visible messages.");
      const messages=[...new Set(data.messages.map(value=>str(value,"message",80)))];
      const updated=await run(tx,`INSERT INTO client_case_message_receipts(org_id,case_id,customer_id,message_id,reader_side,reader_id,employee_id,read_at)
        SELECT m.org_id,m.case_id,?,m.id,?,?,?,? FROM client_case_messages m
        WHERE m.org_id=? AND m.case_id=? AND ${endpointFilter} AND m.direction<>? AND m.id=ANY(?::text[])
        ON CONFLICT(message_id,reader_side,reader_id) DO NOTHING`,row.customer_id,side,viewer.actor.id,viewer.side==="staff"?viewer.actor.id:null,now(),
      row.org_id,row.id,endpoint?.id??null,side,messages);
      return json({ok:true,count:updated.count});
    }

    const key=requiredKey(data.requestId);
    const body=str(data.body,"message",4000,false);
    const attachment=str(data.attachment,"document version",80,false);
    if(!body&&!attachment)return fail(400,"Write a message or attach a case document.");
    if(attachment&&endpoint)return fail(403,"Share private documents only with the assigned case team.");
    const prior=await one<{identical:boolean}>(tx,`SELECT (org_id=? AND case_id=? AND endpoint_id IS NOT DISTINCT FROM ?::text
      AND direction=? AND COALESCE(customer_id,employee_id)=? AND body=? AND COALESCE(attachment_version_id,'')=?) AS identical
      FROM client_case_messages WHERE id=?`,row.org_id,row.id,endpoint?.id??null,side,viewer.actor.id,body,attachment,key);
    if(prior){
      if(!prior.identical)return fail(409,"This message reference was already used. Refresh and try again.");
      return json({ok:true,id:key});
    }
    if(!writable)return fail(409,"Sending messages is unavailable in this conversation.");
    if(attachment&&!await attachmentVersionFor(tx,row,attachment))return fail(404,"This case document version is unavailable.");

    const companyName=endpoint?.name || row.representative_name || "Walshken Case Team";
    const saved=await run(tx,`INSERT INTO client_case_messages(id,org_id,case_id,direction,customer_id,employee_id,display_name,body,created_at,endpoint_id,attachment_version_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,key,row.org_id,row.id,side,viewer.side==="client"?viewer.actor.id:null,
    viewer.side==="staff"?viewer.actor.id:null,viewer.side==="client"?viewer.actor.name:companyName,body,now(),endpoint?.id??null,attachment||null);
    if(!saved.count)return fail(409,"This message reference was already used. Refresh and try again.");
    if(!endpoint)await recordCaseEvent(tx,row,viewer.side==="client"?"Client message sent":"Company message sent",
      viewer.side==="client"?{customerId:viewer.actor.id}:{employeeId:viewer.actor.id});
    if(viewer.side==="client"){
      if(endpoint)await notifyOffice(tx,row,endpoint,key);
      else await notifyCaseStaff(tx,row,"Client case message","Open the case conversation to read a new message.",key);
    }else{
      const params=new URLSearchParams({case:row.id});
      if(endpoint)params.set("thread",endpoint.id);
      await notifyClient(tx,row.customer_id,{type:"case",title:"New secure message",body:"Walshken sent you a message. Open the portal to read it.",
        href:"/customer/contact?"+params.toString(),dedupeKey:"client-message:"+key,email:false});
    }
    return json({ok:true,id:key},201);
  });
}
