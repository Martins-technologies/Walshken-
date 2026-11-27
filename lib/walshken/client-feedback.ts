import { clientCaseFor } from "./client-cases";
import { notifyClient } from "./client-notifications";
import { taskDataset } from "./tasks";
import { all, audit, canSuper, date, fail, id, integer, json, now, one, orgId, pick, run, str, throttle, type Actor, type Db } from "./server";

export const feedbackKinds=["Support request","Complaint","Consultation feedback","Service rating","Case closure feedback"] as const;
export const feedbackStatuses=["New","In review","Responded","Closed"] as const;
type FeedbackStatus=typeof feedbackStatuses[number];
type Feedback={id:string;org_id:string;customer_id:string;case_id:string|null;appointment_id:string|null;kind:typeof feedbackKinds[number];title:string;body:string;rating:number|null;status:FeedbackStatus;created_at:string;updated_at:string;revision:number;reference?:string|null;customer_name?:string};
type Reply={id:string;submission_id:string;body:string;status:FeedbackStatus;created_at:string};
const transitions:Record<FeedbackStatus,readonly FeedbackStatus[]> = {
  New:["In review","Responded","Closed"], "In review":["In review","Responded","Closed"],
  Responded:["In review","Responded","Closed"], Closed:["In review"],
};
export function requireFeedbackAdmin(actor:Actor) {
  if(!canSuper(actor))return fail(403,"Client feedback is available to the authorized administration team.");
}
const publicFields="f.id,f.case_id,f.appointment_id,f.kind,f.title,f.body,f.rating,f.status,f.created_at,f.updated_at,c.reference";

async function feedbackReplies(db:Db,organization:string,owner:string,submissions:string[]) {
  if(!submissions.length)return [];
  return all<Reply>(db,`SELECT id,submission_id,body,status,created_at FROM client_feedback_responses
    WHERE org_id=? AND customer_id=? AND submission_id=ANY(?::text[]) ORDER BY created_at,id LIMIT 250`,organization,owner,submissions);
}

export async function clientFeedbackView(db:Db,owner:string,target:string) {
  const [entries,consultations,cases]=await Promise.all([
    all<Feedback>(db,`SELECT ${publicFields} FROM client_feedback_submissions f LEFT JOIN client_cases c ON c.id=f.case_id AND c.org_id=f.org_id
      WHERE f.org_id=? AND f.customer_id=? AND (?='' OR f.id=?) ORDER BY f.updated_at DESC,f.id LIMIT 100`,orgId,owner,target,target),
    all(db,`SELECT a.id,a.case_id,a.starts_at,a.time_zone,c.reference,c.title FROM client_appointments a
      JOIN client_cases c ON c.org_id=a.org_id AND c.id=a.case_id
      WHERE a.org_id=? AND a.customer_id=? AND a.status='Completed'
        AND NOT EXISTS (SELECT 1 FROM client_feedback_submissions f WHERE f.appointment_id=a.id)
      ORDER BY a.starts_at DESC,a.id LIMIT 100`,orgId,owner),
    all(db,`SELECT id,title,reference,client_status FROM client_cases WHERE org_id=? AND customer_id=? ORDER BY created_at DESC,id LIMIT 100`,orgId,owner),
  ]);
  if(target&&!entries.length)return fail(404,"This request is unavailable.");
  return {entries,cases,consultations,replies:await feedbackReplies(db,orgId,owner,entries.map(entry=>entry.id))};
}

async function notifyFeedbackAdmins(db:Db,reference:string) {
  await run(db,`INSERT INTO notifications (id,employee_id,title,body,href,release_stage)
    SELECT ?||':'||e.id,e.id,'New client feedback','Open the restricted client feedback queue to review the submission.',?,?
    FROM employees e WHERE e.org_id=? AND e.role='super_admin' AND e.status='Active' AND COALESCE(e.employment_status,'')<>'Ended'
    ON CONFLICT(id) DO NOTHING`,reference,"/staff/client-casework?feedback="+encodeURIComponent(reference),taskDataset(),orgId);
}

export async function submitClientFeedback(db:Db,owner:string,data:Record<string,unknown>) {
  await throttle(db,"client-feedback:"+owner,15,60_000);
  const kind=pick(data.kind,feedbackKinds,"feedback type"),title=str(data.title,"subject",140),body=str(data.body,"details",4000);
  const rawCase=str(data.case,"case",80,false),appointment=str(data.appointment,"consultation",80,false),key=str(data.requestId,"submission reference",36);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key))return fail(400,"Refresh the form before submitting.");
  if(title.length<3||body.length<3)return fail(400,"Add a subject and details of at least three characters.");
  const issue=kind==="Support request"||kind==="Complaint",rating=issue?null:integer(data.rating,"rating",1,5);
  if(Boolean(appointment)!==(kind==="Consultation feedback"))return fail(400,"Choose a completed consultation for this feedback.");
  return db.transaction(async tx=>{
    await one(tx,"SELECT id FROM customers WHERE id=? FOR NO KEY UPDATE",owner);
    const consultation=appointment?await one<{case_id:string}>(tx,`SELECT case_id FROM client_appointments
      WHERE id=? AND org_id=? AND customer_id=? AND status='Completed'`,appointment,orgId,owner):null;
    if(appointment&&(!consultation||rawCase&&rawCase!==consultation.case_id))return fail(404,"This completed consultation is unavailable.");
    const selected=consultation?.case_id??rawCase;
    const row=selected?await clientCaseFor(tx,owner,selected):null;
    if(kind==="Case closure feedback"&&(!row||!["Complete","Closed"].includes(row.client_status)))
      return fail(409,"Choose a completed or closed case.");

    const existing=await one<{same:boolean}>(tx,`SELECT (org_id=? AND customer_id=? AND case_id IS NOT DISTINCT FROM ?::text
      AND appointment_id IS NOT DISTINCT FROM ?::text AND kind=? AND title=? AND body=? AND rating IS NOT DISTINCT FROM ?::integer) AS same
      FROM client_feedback_submissions WHERE id=?`,orgId,owner,selected||null,appointment||null,kind,title,body,rating,key);
    if(existing) {
      if(!existing.same)return fail(409,"That submission reference was already used. Refresh and try again.");
      return json({ok:true,id:key});
    }
    const stamp=now();
    const inserted=await run(tx,`INSERT INTO client_feedback_submissions(id,org_id,customer_id,case_id,appointment_id,kind,title,body,rating,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,key,orgId,owner,selected||null,appointment||null,kind,title,body,rating,stamp,stamp);
    if(!inserted.count)return fail(409,"A submission has already been recorded. Open your request history.");
    await notifyFeedbackAdmins(tx,key);
    await notifyClient(tx,owner,{type:"announcement",title:"Submission received",body:"Track the response in Support & feedback.",
      href:"/customer/support?feedback="+encodeURIComponent(key),dedupeKey:"feedback:received:"+key,email:false});
    return json({ok:true,id:key},201);
  });
}

export async function staffFeedbackView(db:Db,actor:Actor,filters:URLSearchParams) {
  requireFeedbackAdmin(actor);
  const selected=str(filters.get("id"),"submission",80,false);
  const query=str(filters.get("status"),"feedback status",20,false);
  if(query)pick(query,feedbackStatuses,"status");
  const to=date(filters.get("to"),"report end",false)??now().slice(0,10);
  const from=date(filters.get("from"),"report start",false)??new Date(Date.parse(to+"T00:00:00Z")-89*86_400_000).toISOString().slice(0,10);
  const duration=Date.parse(to+"T00:00:00Z")-Date.parse(from+"T00:00:00Z");
  if(duration<0||duration>365*86_400_000)return fail(400,"Choose a date range of up to 366 days.");
  const end=new Date(Date.parse(to+"T00:00:00Z")+86_400_000).toISOString().slice(0,10);
  const fields=selected?publicFields:publicFields.replace("f.body","'' AS body");
  const entries=await all<Feedback>(db,`SELECT ${fields},f.customer_id,f.revision,p.name AS customer_name
    FROM client_feedback_submissions f JOIN customers p ON p.id=f.customer_id
    LEFT JOIN client_cases c ON c.id=f.case_id AND c.org_id=f.org_id
    WHERE f.org_id=? AND (?='' OR f.id=?) AND (?='' OR f.status=?)
    ORDER BY f.updated_at DESC,f.id LIMIT 100`,actor.org_id,selected,selected,selected?"":query,query);
  if(selected&&!entries.length)return fail(404,"This feedback submission is unavailable.");
  const [totals,byType]=await Promise.all([
    one(db,`SELECT COUNT(*)::int AS submissions,COUNT(*) FILTER(WHERE kind='Complaint')::int AS complaints,
      COUNT(*) FILTER(WHERE status<>'Closed')::int AS outstanding,ROUND(AVG(rating),2)::text AS average
      FROM client_feedback_submissions WHERE org_id=? AND created_at>=? AND created_at<?`,actor.org_id,from,end),
    all(db,`SELECT kind,COUNT(*)::int AS submissions,COUNT(*) FILTER(WHERE status='Closed')::int AS closed,
      ROUND(AVG(rating),2)::text AS average FROM client_feedback_submissions
      WHERE org_id=? AND created_at>=? AND created_at<? GROUP BY kind ORDER BY kind`,actor.org_id,from,end),
  ]);
  if(selected)await audit(db,actor,"Reviewed confidential client feedback","client feedback",selected).run();
  return {entries,replies:selected?await feedbackReplies(db,actor.org_id,entries[0].customer_id,[selected]):[],report:{from,to,totals,byType}};
}

export async function reviewClientFeedback(db:Db,actor:Actor,data:Record<string,unknown>) {
  requireFeedbackAdmin(actor);
  const target=str(data.id,"feedback submission",80),revision=integer(data.revision,"revision",1,2_000_000_000);
  const status=pick(data.status,feedbackStatuses,"status"),body=str(data.body,"client response",4000,false);
  if(status==="Responded"&&body.length<3||body&&body.length<3)return fail(400,"Enter a client response with at least three characters.");
  return db.transaction(async tx=>{
    const row=await one<Feedback>(tx,"SELECT * FROM client_feedback_submissions WHERE id=? AND org_id=? FOR UPDATE",target,actor.org_id);
    if(!row)return fail(404,"This feedback submission is unavailable.");
    if(row.revision!==revision)return fail(409,"This submission changed. Reload before updating it.");
    if(!transitions[row.status].includes(status)||status===row.status&&!body)return fail(409,"Choose a permitted status change or add a reply.");
    const stamp=now();
    await run(tx,"UPDATE client_feedback_submissions SET status=?,updated_at=?,revision=revision+1 WHERE id=? AND org_id=?",status,stamp,target,actor.org_id);
    if(body)await run(tx,`INSERT INTO client_feedback_responses(id,org_id,customer_id,submission_id,employee_id,body,status,created_at)
      VALUES(?,?,?,?,?,?,?,?)`,id(),actor.org_id,row.customer_id,target,actor.id,body,status,stamp);
    await audit(tx,actor,"Updated client support status: "+status,"client feedback",target).run();
    if(body||status==="Closed")await notifyClient(tx,row.customer_id,{type:"announcement",title:"Support request updated",body:"Sign in to see the update in Support & feedback.",
      href:"/customer/support?feedback="+encodeURIComponent(target),dedupeKey:`feedback:update:${target}:${revision+1}`});
    return json({ok:true});
  });
}
