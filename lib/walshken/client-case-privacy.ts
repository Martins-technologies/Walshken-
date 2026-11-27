import { assertClientCaseUnheld, clientCaseFor, clientCaseView, requireClientCases, type CaseCustomer } from "./client-cases";
import { clientProfileSnapshot } from "./client-profile";
import { exportClientJourney } from "./client-journey";
import { clientSecurityEvent } from "./client-sessions";
import { notifyClient } from "./client-notifications";
import { all, audit, canSuper, fail, id, integer, json, now, one, orgId, pick, run, str, throttle, type Actor, type Db } from "./server";

export const privacyRequestTypes = ["Data access", "Data export", "Document deletion", "Account closure", "Correction"] as const;
const decisions = ["Under review","Approved","Declined","Completed"] as const;
type RequestType=typeof privacyRequestTypes[number];
type PrivacyStatus="Submitted"|typeof decisions[number];
type PrivacyRequest={id:string;org_id:string;customer_id:string;case_id:string|null;type:RequestType;status:PrivacyStatus;revision:number;public_response:string|null};
type PrivacyPolicy={id:string;notice:string;reference:string;retention_days:number;published_at:string};

async function policy(db:Db,organization=orgId) {
  return one<PrivacyPolicy>(db,`SELECT id,notice,reference,retention_days,published_at FROM client_privacy_policies
    WHERE org_id=? ORDER BY published_at DESC,id DESC LIMIT 1`,organization);
}

export async function clientPrivacyView(db:Db,customerId:string,target="",limit=100) {
  requireClientCases();
  const rootQuery=target?"AND (case_id IS NULL OR case_id=?)":"";
  const args=target?[target]:[];
  const [privacyPolicy,privacyRequests,consents]=await Promise.all([
    policy(db),
    all(db,`SELECT id,case_id,type,reason,status,public_response,created_at FROM client_privacy_requests
      WHERE org_id=? AND customer_id=? ${rootQuery} ORDER BY created_at DESC,id DESC LIMIT ?`,orgId,customerId,...args,limit),
    all(db,`SELECT id,case_id,policy_id,decision,created_at FROM client_consent_records
      WHERE org_id=? AND customer_id=? ${rootQuery} ORDER BY created_at DESC,id DESC LIMIT ?`,orgId,customerId,...args,limit),
  ]);
  return {privacyPolicy,privacyRequests,consents};
}

export async function staffClientPrivacyView(db:Db,actor:Actor) {
  requireClientCases();
  if(!canSuper(actor))return fail(403,"Organization privacy administration is required.");
  const [privacyPolicy,privacyRequests,legalHolds]=await Promise.all([
    policy(db,actor.org_id),
    all(db,`SELECT r.id,r.customer_id,r.case_id,r.type,r.reason,r.status,r.public_response,r.revision,r.created_at,c.name AS customer_name,k.reference
      FROM client_privacy_requests r JOIN customers c ON c.id=r.customer_id
      LEFT JOIN client_cases k ON k.id=r.case_id AND k.org_id=r.org_id WHERE r.org_id=?
      ORDER BY CASE WHEN r.status IN ('Submitted','Under review') THEN 0 ELSE 1 END,r.created_at DESC,r.id LIMIT 100`,actor.org_id),
    all(db,`SELECT h.id,h.customer_id,h.case_id,h.reason,h.created_by,h.created_at,c.name AS customer_name,k.reference,release.created_at AS released_at
      FROM client_case_legal_holds h JOIN customers c ON c.id=h.customer_id
      LEFT JOIN client_cases k ON k.id=h.case_id AND k.org_id=h.org_id
      LEFT JOIN client_case_hold_releases release ON release.hold_id=h.id WHERE h.org_id=?
      ORDER BY CASE WHEN release.hold_id IS NULL THEN 0 ELSE 1 END,h.created_at DESC,h.id LIMIT 100`,actor.org_id),
  ]);
  return {privacyPolicy,privacyRequests,legalHolds,viewer:actor.id};
}

export async function customerPrivacyAction(db:Db,customerId:string,action:string,data:Record<string,unknown>) {
  requireClientCases();
  await throttle(db,"client-privacy:"+customerId,20,60_000);
  return db.transaction(async tx=>{
    const target=str(data.case,"case",80,false);
    if(target)await clientCaseFor(tx,customerId,target,true);
    if(action==="privacy-request") {
      const type=pick(data.type,privacyRequestTypes,"privacy request");
      if(type==="Document deletion"&&!target)return fail(400,"Choose the case containing the document.");
      const reason=str(data.reason,"request details",2000),key=id();
      await run(tx,`INSERT INTO client_privacy_requests(id,org_id,customer_id,case_id,type,reason,created_at)
        VALUES(?,?,?,?,?,?,?)`,key,orgId,customerId,target||null,type,reason,now());
      await notifyClient(tx,customerId,{type:"security",title:"Privacy request received",body:"Track your request securely in the portal.",href:"/customer/security",dedupeKey:key+":received",email:false});
      return json({ok:true,id:key,message:"Your privacy request was submitted."},201);
    }
    if(action!=="consent") return fail(404,"This privacy action is unavailable.");
    await one(tx,"SELECT id FROM customers WHERE id=? FOR NO KEY UPDATE",customerId);
    const current=await policy(tx);
    if(!current)return fail(409,"The organization must publish a privacy notice before consent can be recorded.");
    if(str(data.policyRevision,"policy revision",80)!==current.id)return fail(409,"The privacy notice changed. Read the current version before continuing.");
    const decision=pick(data.decision,["Accepted","Withdrawn"] as const,"consent");
    const record=await one<{decision:string}>(tx,`SELECT decision FROM client_consent_records WHERE org_id=? AND customer_id=?
      AND case_id IS NOT DISTINCT FROM ? AND policy_id=? ORDER BY created_at DESC,id DESC LIMIT 1`,orgId,customerId,target||null,current.id);
    if(record?.decision===decision)return json({ok:true,message:"Your consent decision is already saved."});
    await run(tx,`INSERT INTO client_consent_records(id,org_id,customer_id,case_id,policy_id,decision,created_at)
      VALUES(?,?,?,?,?,?,?)`,id(),orgId,customerId,target||null,current.id,decision,now());
    return json({ok:true,message:"Your consent decision was recorded."},201);
  });
}

export async function clientPrivacyExport(db:Db,customerId:string,requestId:string) {
  requireClientCases();
  const row=await one<PrivacyRequest>(db,`SELECT id,org_id,customer_id,case_id,type,status,revision FROM client_privacy_requests
    WHERE id=? AND org_id=? AND customer_id=? AND type IN('Data access','Data export') AND status IN('Approved','Completed')`,requestId,orgId,customerId);
  if(!row)return fail(404,"An authorized data export is unavailable for this request.");
  const account=await one<CaseCustomer & {created_at:string}>(db,"SELECT id,name,email,created_at FROM customers WHERE id=?",customerId);
  if(!account)return fail(404,"The client account is unavailable.");
  const caseIds=await all<{id:string}>(db,`SELECT id FROM client_cases WHERE org_id=? AND customer_id=? AND (?='' OR id=?)
    ORDER BY updated_at DESC,id LIMIT 101`,orgId,customerId,row.case_id??"",row.case_id??"");
  if(caseIds.length>100)return fail(409,"Contact the privacy team for an export covering all of your cases.");
  const cases=[];
  for(const target of caseIds) {
    const data=await clientCaseView(db,customerId,target.id,501);
    if([data.updates,data.requests,data.messages].some(items=>(items?.length??0)>500))
      return fail(409,"Contact the privacy team for a complete export of this case history.");
    cases.push({...data,journey:await exportClientJourney(db,customerId,target.id)});
  }
  const caseFilter=[orgId,customerId,row.case_id??"",row.case_id??""];
  const [privacy,profile,documentMetadata,calls,invoices,invoiceItems,payments,agreements,feedback,feedbackResponses]=await Promise.all([
    clientPrivacyView(db,customerId,row.case_id??"",1001),
    row.case_id?null:clientProfileSnapshot(db,account),
    all(db,`SELECT d.id,d.case_id,d.request_id,d.category,d.description,d.review_status,d.created_at,d.updated_at,d.deleted_at,
      v.version,v.filename,v.mime,v.byte_size,v.page_count,v.submitted_at
      FROM client_documents d LEFT JOIN client_document_versions v ON v.document_id=d.id AND v.org_id=d.org_id
      WHERE d.org_id=? AND d.customer_id=? AND (?='' OR d.case_id=?) ORDER BY d.created_at,d.id,v.version LIMIT 1001`,...caseFilter),
    all(db,`SELECT id,case_id,company_name,mode,status,initiator,created_at,connected_at,ended_at FROM client_calls
      WHERE org_id=? AND customer_id=? AND (?='' OR case_id=?) ORDER BY created_at,id LIMIT 1001`,...caseFilter),
    all(db,`SELECT i.id,i.case_id,i.invoice_number,i.issuer_name,i.issuer_address,i.currency,i.issue_on,i.due_on,i.subtotal_minor,i.tax_minor,i.total_minor,i.status
      FROM client_invoices i WHERE i.org_id=? AND i.customer_id=? AND (?='' OR i.case_id=?) AND i.status<>'Draft'
      ORDER BY i.created_at,i.id LIMIT 1001`,...caseFilter),
    all(db,`SELECT i.invoice_number,l.position,l.description,l.quantity,l.unit_minor,l.tax_bps,l.total_minor
      FROM client_invoice_items l JOIN client_invoices i ON i.id=l.invoice_id AND i.org_id=l.org_id
      WHERE i.org_id=? AND i.customer_id=? AND (?='' OR i.case_id=?) AND i.status<>'Draft'
      ORDER BY i.created_at,i.id,l.position LIMIT 1001`,...caseFilter),
    all(db,`SELECT i.invoice_number,p.amount_minor,p.currency,p.sandbox,p.status,p.created_at,p.confirmed_at,p.receipt_number
      FROM client_payments p JOIN client_invoices i ON i.org_id=p.org_id AND i.id=p.invoice_id
      WHERE i.org_id=? AND i.customer_id=? AND (?='' OR i.case_id=?) AND i.status<>'Draft'
      ORDER BY p.created_at,p.id LIMIT 1001`,...caseFilter),
    all(db,`SELECT a.case_id,v.version,v.title,v.issuer_name,v.terms,v.undertakings,v.content_hash,v.published_at,v.withdrawn_at,
      r.decision,r.signer_name,r.signer_email,r.consent_version,r.consent,r.responded_at,r.signed_pdf_hash
      FROM client_agreements a JOIN client_agreement_versions v ON v.org_id=a.org_id AND v.agreement_id=a.id
      LEFT JOIN client_agreement_responses r ON r.org_id=a.org_id AND r.version_id=v.id AND r.customer_id=a.customer_id
      WHERE a.org_id=? AND a.customer_id=? AND (?='' OR a.case_id=?) AND v.published_at IS NOT NULL
      ORDER BY v.published_at,v.id LIMIT 1001`,...caseFilter),
    all(db,`SELECT f.id,f.case_id,f.appointment_id,f.kind,f.title,f.body,f.rating,f.status,f.created_at,f.updated_at
      FROM client_feedback_submissions f WHERE f.org_id=? AND f.customer_id=? AND (?='' OR f.case_id=?)
      ORDER BY f.created_at,f.id LIMIT 1001`,...caseFilter),
    all(db,`SELECT r.submission_id,r.body,r.status,r.created_at FROM client_feedback_responses r
      JOIN client_feedback_submissions f ON f.org_id=r.org_id AND f.id=r.submission_id AND f.customer_id=r.customer_id
      WHERE f.org_id=? AND f.customer_id=? AND (?='' OR f.case_id=?) ORDER BY r.created_at,r.id LIMIT 1001`,...caseFilter),
  ]);
  if([documentMetadata,calls,invoices,invoiceItems,payments,agreements,feedback,feedbackResponses,privacy.consents,privacy.privacyRequests].some(items=>items.length>1000))
    return fail(409,"Contact the privacy team for an export covering all matching records.");
  const body={
    request:row.id,scope:row.case_id?"Selected case":"Account and cases",account,profile,cases,documentMetadata,calls,invoices,invoiceItems,payments,agreements,feedback,feedbackResponses,
    consents:privacy.consents,privacyRequests:privacy.privacyRequests,
  };
  if(Buffer.byteLength(JSON.stringify(body))>3_000_000)return fail(409,"Contact the privacy team for a complete export of these records.");
  await clientSecurityEvent(db,customerId,null,"Downloaded an approved client data export");
  return json(body,200,{"Content-Disposition":'attachment; filename="walshken-client-case-data.json"'});
}

const permitted:Record<PrivacyStatus,readonly (typeof decisions[number])[]> = {
  Submitted:["Under review","Approved","Declined"],
  "Under review":["Approved","Declined"],
  Approved:["Completed"],
  Declined:[],
  Completed:[],
};

export async function staffClientPrivacyAction(db:Db,actor:Actor,action:string,data:Record<string,unknown>) {
  requireClientCases();
  if(!canSuper(actor))return fail(403,"Organization privacy administration is required.");
  await throttle(db,"staff-client-privacy:"+actor.id,50,60_000);
  return db.transaction(async tx=>{
    await one(tx,"SELECT id FROM organizations WHERE id=? FOR UPDATE",actor.org_id);
    const at=now(),key=id();
    if(action==="privacy-policy") {
      const reference=str(data.reference,"policy source URL",500);
      try { if(new URL(reference).protocol!=="https:")return fail(400,"An HTTPS policy reference is required."); }
      catch { return fail(400,"An HTTPS policy reference is required."); }
      await run(tx,`INSERT INTO client_privacy_policies(id,org_id,notice,reference,retention_days,published_by,published_at)
        VALUES(?,?,?,?,?,?,?)`,key,actor.org_id,str(data.notice,"approved privacy notice",12000),reference,integer(data.retentionDays,"retention days",1,36500),actor.id,at);
      await audit(tx,actor,"Client privacy policy published","client privacy policy",key).run();
      return json({ok:true,message:"Privacy policy version published."},201);
    }
    if(action==="privacy-hold") {
      const customerId=str(data.customer,"client account",80),caseId=str(data.case,"case",80,false);
      if(caseId)await clientCaseFor(tx,customerId,caseId,true);
      else if(!await one(tx,"SELECT id FROM customers WHERE id=?",customerId))return fail(404,"This client account is unavailable.");
      await run(tx,`INSERT INTO client_case_legal_holds(id,org_id,customer_id,case_id,reason,created_by,created_at)
        VALUES(?,?,?,?,?,?,?)`,key,actor.org_id,customerId,caseId||null,str(data.reason,"legal hold reason",2000),actor.id,at);
      await audit(tx,actor,"Client legal hold placed","client legal hold",key).run();
      return json({ok:true,id:key,message:"Legal hold placed."},201);
    }
    if(action==="privacy-release"){
      const hold=await one<{id:string;customer_id:string;case_id:string|null;created_by:string}>(tx,`SELECT id,customer_id,case_id,created_by
        FROM client_case_legal_holds WHERE id=? AND org_id=? FOR UPDATE`,str(data.hold,"legal hold",80),actor.org_id);
      if(!hold)return fail(404,"This legal hold is unavailable.");
      if(hold.created_by===actor.id)return fail(403,"A different Super Admin must review the release.");
      if(hold.case_id)await clientCaseFor(tx,hold.customer_id,hold.case_id,true);
      const result=await run(tx,`INSERT INTO client_case_hold_releases(hold_id,released_by,created_at,reason) VALUES(?,?,?,?)
        ON CONFLICT(hold_id) DO NOTHING`,hold.id,actor.id,at,str(data.reason,"release justification",2000));
      if(!result.count)return fail(409,"The hold is already released.");
      await audit(tx,actor,"Client legal hold released","client legal hold",hold.id).run();
      return json({ok:true,message:"Legal hold released."});
    }
    if(action!=="privacy-decision")return fail(404,"This privacy action is unavailable.");
    const row=await one<PrivacyRequest>(tx,"SELECT * FROM client_privacy_requests WHERE id=? AND org_id=? FOR UPDATE",str(data.request,"privacy request",80),actor.org_id);
    if(!row)return fail(404,"This privacy request is unavailable.");
    if(integer(data.revision,"request revision",1,2147483646)!==row.revision)return fail(409,"The request changed. Refresh before continuing.");
    const decision=pick(data.decision,decisions,"privacy decision");
    if(!permitted[row.status].includes(decision))return fail(409,"That decision is not available for the current request state.");
    if(row.type==="Document deletion"&&decision==="Completed"){
      if(!row.case_id)return fail(409,"A case reference is required before completing document deletion.");
      await clientCaseFor(tx,row.customer_id,row.case_id,true);
      await assertClientCaseUnheld(tx,row.case_id,row.customer_id);
      const disposal=str(data.disposal,"completed document disposal ID",80);
      if(!await one(tx,`SELECT id FROM client_document_disposals WHERE id=? AND org_id=? AND case_id=? AND customer_id=?
        AND status='Disposed' AND disposed_at IS NOT NULL`,disposal,row.org_id,row.case_id,row.customer_id))
        return fail(409,"Complete the authorized document disposal for this case before closing the privacy request.");
    }
    const privateReason=str(data.reason,"decision evidence",3000),response=str(data.response,"customer-facing response",1500);
    await run(tx,`INSERT INTO client_privacy_decisions(id,request_id,employee_id,decision,private_reason,public_response,created_at)
      VALUES(?,?,?,?,?,?,?)`,key,row.id,actor.id,decision,privateReason,response,at);
    await run(tx,"UPDATE client_privacy_requests SET status=?,public_response=?,revision=revision+1 WHERE id=?",decision,response,row.id);
    if(row.type==="Account closure"&&decision==="Completed"){
      const identity=await one(tx,"SELECT id FROM customers WHERE id=? FOR UPDATE",row.customer_id);
      if(!identity)return fail(404,"This client account is unavailable.");
      await run(tx,"UPDATE customers SET suspended_at=COALESCE(suspended_at,?) WHERE id=?",at,row.customer_id);
      await run(tx,"UPDATE customer_sessions SET ended_at=?,expires_at=LEAST(expires_at,?) WHERE customer_id=? AND ended_at IS NULL",at,at,row.customer_id);
    }else{
      await notifyClient(tx,row.customer_id,{type:"security",title:"Privacy request updated",body:"Review the decision in your portal.",href:"/customer/security",dedupeKey:key+":decision",email:false});
    }
    await audit(tx,actor,"Client privacy request: "+decision,"client privacy request",row.id).run();
    return json({ok:true,message:"The privacy decision was saved."});
  });
}
