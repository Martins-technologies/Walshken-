import assert from "node:assert/strict";
import {createHash,createHmac,randomBytes,randomUUID} from "node:crypto";
import {copyFileSync,mkdirSync,mkdtempSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {GET as clientGet,POST as clientPost} from "../app/api/client-finance/route.ts";
import {GET as staffGet,POST as staffPost} from "../app/api/client-finance/staff/route.ts";
import {POST as webhookPost} from "../app/api/client-finance/stripe/route.ts";
import {workspaceDatabase} from "../lib/walshken/database.ts";
import {withClientDb} from "../lib/walshken/client-feature.ts";

assert.equal(process.env.NODE_ENV,"test");
assert.equal(process.env.DATABASE_URL,undefined,"Client finance tests must not query a hosted database");
const repo=process.cwd(),sandbox=mkdtempSync(join(tmpdir(),"walshken-client-finance-"));
process.on("exit",()=>rmSync(sandbox,{recursive:true,force:true}));
mkdirSync(join(sandbox,"drizzle"));
mkdirSync(join(sandbox,"public"));
for(const name of readdirSync(join(repo,"drizzle")).filter(file=>file.endsWith(".sql")))copyFileSync(join(repo,"drizzle",name),join(sandbox,"drizzle",name));
writeFileSync(join(sandbox,"drizzle","00000_roles.sql"),"CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
const files=[
 "20261122145905_staff_document_security.sql",
 "20261122192455_employee_task_workflow.sql",
 "20261122203136_employee_attendance_shifts_timesheets.sql",
 "20261125093948_project_lifecycle_and_workforce_reporting.sql",
 "20261125231710_staff_unit_memberships.sql",
 "20261126041500_project_assignments_and_deliverables.sql",
 "20261127090000_client_identity.sql",
 "20261127090200_client_cases.sql",
 "20261127090600_client_finance.sql",
 "20261128104000_client_payment_plans.sql",
 "20261128105000_client_preferences_and_mfa.sql",
];
for(const [index,file] of files.entries())copyFileSync(join(repo,"supabase","migrations",file),join(sandbox,"drizzle",String(100+index).padStart(4,"0")+"_"+file));
copyFileSync(join(repo,"public","payroll-font.ttf"),join(sandbox,"public","payroll-font.ttf"));
process.chdir(sandbox);
Object.assign(process.env,{
 WALSHKEN_CLIENT_PORTAL_ENABLED:"1",WALSHKEN_REQUIRE_STAFF_MFA:"0",VERCEL_ENV:"preview",
 WALSHKEN_STRIPE_SECRET_KEY:"sk_test_"+randomBytes(24).toString("hex"),WALSHKEN_STRIPE_WEBHOOK_SECRET:"whsec_"+randomBytes(24).toString("hex"),
});
const db=workspaceDatabase();
const query=(sql,...params)=>db.prepare(sql,params);
const site="https://finance.walshken.test",stamp=new Date().toISOString(),future=new Date(Date.now()+86_400_000).toISOString();
const digest=value=>createHash("sha256").update(value).digest("hex");
let seller;
async function request(path,actor,body,expected=200,options={}){
 const isStaff=path.startsWith("/staff"),isWebhook=path==="/stripe";
 const handler=isWebhook?webhookPost:isStaff?(body?staffPost:staffGet):(body?clientPost:clientGet);
 const result=await handler(new Request(site+"/api/client-finance"+path,{method:body?"POST":"GET",
  headers:{Origin:options.origin??site,...(actor?{Cookie:actor.cookie}:{}),...(body?{"Content-Type":"application/json"}:{}),...options.headers},
  body:body?(typeof body==="string"?body:JSON.stringify(body)):undefined,
 }));
 if(result.status!==expected)assert.fail(`Expected ${expected}, received ${result.status} for ${path} ${body?.action??""}: ${await result.text()}`);
 return result;
}
const get=async(path,actor,expected=200)=>(await request(path,actor,null,expected)).json();
const post=async(path,actor,body,expected=200)=>(await request(path,actor,body,expected)).json();
await query("INSERT INTO organizations(id,name,time_zone) VALUES('walshken','Walshken','UTC')").run();
async function staff(role,name){
 const key=randomUUID(),email=key+"@staff.example.org",token=randomUUID()+randomUUID();
 await query("INSERT INTO employees(id,org_id,employee_no,name,email,role) VALUES(?,'walshken',?,?,?,?)",key,key,name,email,role).run();
 await query("INSERT INTO sessions(id,employee_id,expires_at,agent) VALUES(?,?,?,'QA')",digest(token),key,future).run();
 return {id:key,cookie:"walshken_session="+token};
}
async function customer(name,verified=true){
 const key=randomUUID(),email=key+"@client.example.org",token=randomBytes(32).toString("hex");
 await query("INSERT INTO customers(id,name,email,password_hash,email_verified_at) VALUES(?,?,?,'fixture',?)",key,name,email,verified?stamp:null).run();
 await query(`INSERT INTO customer_sessions(id,customer_id,expires_at,session_ref,created_at,last_seen_at,idle_expires_at,reauthenticated_at,device_label,device_digest)
   VALUES(?,?,?,?,?,?,?,?,'QA','fixture')`,digest(token),key,future,randomUUID(),stamp,stamp,future,stamp).run();
 return {id:key,cookie:"walshken_customer="+token,sessionHash:digest(token),name};
}
const owner=await customer("Jamie Client"),stranger=await customer("Taylor Client"),unverified=await customer("Unverified",false);
seller=await staff("super_admin","Billing admin");
const assigned=await staff("employee","Assigned representative"),outsider=await staff("employee","Other representative");
const scopedAdmin=await staff("admin","Case administrator");
const department=randomUUID(),otherDepartment=randomUUID();
for(const [key,name] of [[department,"Client Services"],[otherDepartment,"Other Department"]]){
 await query("INSERT INTO units(id,org_id,kind,name) VALUES(?,'walshken','Department',?)",key,name).run();
}
await query("UPDATE employees SET department_id=? WHERE id IN (?,?)",department,scopedAdmin.id,assigned.id).run();
const caseId=randomUUID(),otherCase=randomUUID();
for(const [idx,account,key] of [[1,owner,caseId],[2,stranger,otherCase]]){
 await query(`INSERT INTO client_cases(id,org_id,customer_id,reference,title,service,country,assigned_employee_id,representative_name,created_at,updated_at)
  VALUES(?,'walshken',?,?,'Immigration case','Immigration','CA',?,'Representative',?,?)`,key,account.id,"CASE-"+idx,assigned.id,stamp,stamp).run();
}

await query("UPDATE client_cases SET department_id=? WHERE id=?",department,caseId).run();
await query("UPDATE client_cases SET department_id=? WHERE id=?",otherDepartment,otherCase).run();
const staffPath="/staff?caseId="+caseId;
await get("",null,401);
await get("",unverified,403);
await get(staffPath,outsider,404);
assert.equal((await get(staffPath,assigned)).canManage,false);
assert.equal((await get(staffPath,scopedAdmin)).canManage,true);
await get("/staff?caseId="+otherCase,scopedAdmin,404);
await post("/staff",assigned,{caseId,action:"invoice-save"},403);
const base={caseId,action:"invoice-save",issuerName:"Walshken QA",issuerAddress:"QA Billing address",issuerTaxNumber:"TEST",
 dueOn:future.slice(0,10),currency:"CAD",items:[{description:"Immigration file preparation",quantity:2,unitMinor:5250,taxBps:500},{description:"Application guidance",quantity:1,unitMinor:10000,taxBps:500}]};
await post("/staff",scopedAdmin,{...base,caseId:otherCase},404);
const saved=await post("/staff",scopedAdmin,base);
assert.equal((await get("",owner)).invoices.length,0);
await post("/staff",seller,{...base,id:saved.id});
await post("/staff",seller,{caseId,action:"invoice-issue",id:saved.id});
const invoice=(await get("",owner)).invoices[0];
assert.equal(invoice.total_minor,21525);
assert.match(invoice.invoice_number,/^WAL-\d{4}-\d{6}$/);
assert.equal((await get("",stranger)).invoices.length,0);
const expectedSummary={outstandingInvoices:1,pendingAgreements:0,balances:[{currency:"CAD",amount_minor:"21525",invoices:1}]};
assert.deepEqual(await get("?summary=1",owner),expectedSummary);
assert.deepEqual(await get("?summary=1&caseId="+caseId,owner),expectedSummary);
assert.deepEqual(await get("?summary=1&caseId="+caseId,stranger),{outstandingInvoices:0,pendingAgreements:0,balances:[]});
assert.deepEqual(await get("?summary=1&caseId="+otherCase,owner),{outstandingInvoices:0,pendingAgreements:0,balances:[]});
await post("/staff",seller,{caseId,action:"invoice-save",id:invoice.id,...base},409);
await assert.rejects(query(`INSERT INTO client_invoice_items(org_id,invoice_id,position,description,quantity,unit_minor,tax_bps,subtotal_minor,tax_minor,total_minor)
 VALUES('walshken',?,3,'Unexpected line',1,2,0,2,0,2)`,invoice.id).run(),/immutable/);
await get("?kind=invoice&id="+invoice.id,stranger,404);
const invoicePdf=Buffer.from(await (await request("?kind=invoice&id="+invoice.id,owner)).arrayBuffer());
assert.equal(invoicePdf.subarray(0,5).toString(),"%PDF-");

const actualFetch=globalThis.fetch;
let sessionCounter=0,checkoutRequests=[];
globalThis.fetch=async(url,params)=>{
 assert.equal(url,"https://api.stripe.com/v1/checkout/sessions");
 const form=params.body;
 assert.equal(new URL(form.get("success_url")).origin,site);
 assert.equal(form.get("line_items[0][price_data][unit_amount]"),"21525");
 assert.equal(form.get("mode"),"payment");
 checkoutRequests.push(params);
 return Response.json({id:"cs_test_Session"+(++sessionCounter),url:"https://checkout.stripe.com/c/pay/test"+sessionCounter,expires_at:Math.floor(Date.now()/1000)+3600,livemode:false});
};
try {
 await post("",stranger,{action:"checkout",id:invoice.id},404);
 const first=await post("",owner,{action:"checkout",id:invoice.id});
 assert.match(first.url,/^https:\/\/checkout.stripe\.com/);
 assert.equal((await post("",owner,{action:"checkout",id:invoice.id})).url,first.url);
 assert.equal(checkoutRequests.length,1,"Active checkout must be reused");
 assert.equal((await get("",owner)).invoices[0].status,"Open","Redirect/session creation cannot confirm paid");
 const payment=(await get("",owner)).payments[0];
 await get("?kind=receipt&id="+payment.id,owner,404);

 async function webhook(payment,eventId,type,sessionId,paymentStatus,expected=200,changes={},timestamp=Math.floor(Date.now()/1000),valid=true){
  const body=JSON.stringify({id:eventId,type,created:Math.floor(Date.parse(stamp)/1000),livemode:false,
   data:{object:{id:sessionId,object:"checkout.session",mode:"payment",livemode:false,payment_status:paymentStatus,currency:"cad",amount_total:invoice.total_minor,
      payment_intent:type.endsWith("expired")?null:"pi_Ref"+sessionId.at(-1),client_reference_id:payment.id,
      metadata:{walshken_payment_id:payment.id,walshken_invoice_id:invoice.id},...changes}}});
  const tag=createHmac("sha256",process.env.WALSHKEN_STRIPE_WEBHOOK_SECRET).update(timestamp+"."+body).digest("hex");
  return (await request("/stripe",null,body,expected,{headers:{"Stripe-Signature":`t=${timestamp},v1=${valid?tag:"0".repeat(64)}`}})).json();
 }
 await webhook(payment,"evt_NoSig","checkout.session.completed","cs_test_Session1","paid",400,{},undefined,false);
 await webhook(payment,"evt_Stale","checkout.session.completed","cs_test_Session1","paid",400,{},Math.floor(Date.now()/1000)-600);
 await webhook(payment,"evt_Mismatch","checkout.session.completed","cs_test_Session1","paid",400,{amount_total:123});
 await webhook(payment,"evt_Failed","checkout.session.async_payment_failed","cs_test_Session1","unpaid");
 assert.equal((await get("",owner)).payments[0].status,"Failed");
 assert.equal((await get("",owner)).invoices[0].status,"Open");
 await post("",owner,{action:"checkout",id:invoice.id});
 assert.equal(checkoutRequests.length,2);
 const next=(await get("",owner)).payments.find(row=>row.status==="Pending");
 await webhook(next,"evt_Process","checkout.session.completed","cs_test_Session2","unpaid");
 assert.equal((await get("",owner)).invoices[0].status,"Processing");
 await webhook(next,"evt_Paid","checkout.session.async_payment_succeeded","cs_test_Session2","paid");
 assert.equal((await webhook(next,"evt_Paid","checkout.session.async_payment_succeeded","cs_test_Session2","paid")).duplicate,true);
 await webhook(next,"evt_Paid","checkout.session.completed","cs_test_Session2","paid",409);
 await webhook(next,"evt_Expired","checkout.session.expired","cs_test_Session2","unpaid");
 const final=await get("",owner),receipt=final.payments.find(row=>row.status==="Paid");
 assert.equal(final.invoices[0].status,"Paid");
 assert.equal(receipt.provider_reference,"pi_Ref2");
 assert.match(receipt.receipt_number,/^RCP-WAL-/);
 const receiptPdf=Buffer.from(await (await request("?kind=receipt&id="+receipt.id,owner)).arrayBuffer());
 assert.equal(receiptPdf.subarray(0,5).toString(),"%PDF-");
 await get("?kind=receipt&id="+receipt.id,stranger,404);
 await post("",owner,{action:"checkout",id:invoice.id},409);
 const notice=await query("SELECT count(*)::int AS count FROM client_notifications WHERE customer_id=? AND dedupe_key=?",owner.id,"payment-confirmed:"+next.id).first();
 assert.equal(notice.count,1,"Duplicate provider deliveries must not duplicate customer notification");
} finally { globalThis.fetch=actualFetch; }
delete process.env.WALSHKEN_STRIPE_WEBHOOK_SECRET;
assert.equal((await get("",owner)).checkoutMode,"unconfigured");
process.env.WALSHKEN_STRIPE_WEBHOOK_SECRET="whsec_"+randomBytes(24).toString("hex");
process.env.WALSHKEN_STRIPE_SECRET_KEY="sk_live_"+randomBytes(24).toString("hex");
process.env.WALSHKEN_STRIPE_MODE="live";
assert.equal((await get("",owner)).checkoutMode,"unconfigured","Preview must reject live Stripe credentials");
process.env.VERCEL_ENV="production";
process.env.WALSHKEN_STRIPE_SECRET_KEY="sk_test_"+randomBytes(24).toString("hex");
assert.equal((await get("",owner)).checkoutMode,"unconfigured","Production must reject sandbox payments");
process.env.VERCEL_ENV="preview";
console.log("PASS authorized invoices, invoice PDF/totals, hosted checkout contract, signed webhooks, asynchronous payment, failed/replayed/out-of-order events, and private receipts");

const agreementDraft={caseId,action:"agreement-save",title:"Immigration services agreement",issuerName:"Walshken QA",
 terms:"This exact version defines approved company services.",undertakings:"Provide accurate records on request."};
const firstVersion=await post("/staff",seller,agreementDraft);
assert.equal((await get("",owner)).agreements.length,0);
await post("/staff",seller,{caseId,action:"agreement-publish",id:firstVersion.id});
const issued=(await get("",owner)).agreements[0];
assert.equal(issued.status,"Issued");
assert.equal((await get("?summary=1",owner)).pendingAgreements,1);
await get("?kind=agreement&id="+issued.id,stranger,404);
const draft=await post("/staff",seller,{...agreementDraft,agreementId:issued.agreement_id,terms:"The second published version defines updated approved services."});
await post("/staff",seller,{caseId,action:"agreement-publish",id:draft.id});
const versions=(await get("",owner)).agreements;
assert.equal(versions.find(row=>row.id===issued.id).status,"Withdrawn");
const signable=versions.find(row=>row.id===draft.id);
const sign={action:"agreement-sign",id:signable.id,contentHash:signable.content_hash,name:owner.name,consent:true};
await request("",owner,sign,403,{origin:"https://wrong.example.org"});
await post("",owner,{...sign,consent:false},400);
await post("",owner,{...sign,contentHash:"a".repeat(64)},409);
await post("",stranger,{...sign,name:stranger.name},404);
await query("UPDATE customer_sessions SET reauthenticated_at='2024-01-01T00:00:00.000Z' WHERE id=?",owner.sessionHash).run();
await post("",owner,sign,403);
await query("UPDATE customer_sessions SET reauthenticated_at=? WHERE id=?",stamp,owner.sessionHash).run();
await post("",owner,sign);
assert.equal((await get("",owner)).agreements.find(row=>row.id===signable.id).status,"Signed");
assert.equal((await get("?summary=1",owner)).pendingAgreements,0);
await post("",owner,sign,409);
const signed=await request("?kind=agreement&id="+signable.id,owner);
const copy=Buffer.from(await signed.arrayBuffer());
assert.equal(copy.subarray(0,5).toString(),"%PDF-");
assert.deepEqual(copy,Buffer.from(await (await request("?kind=agreement&id="+signable.id,owner)).arrayBuffer()),"Retrieval must preserve exact signed bytes");
await assert.rejects(query("UPDATE client_agreement_responses SET consent_version='changed' WHERE version_id=?",signable.id).run(),/immutable/);
await assert.rejects(query("UPDATE client_agreement_versions SET terms='changed' WHERE id=?",signable.id).run(),/immutable/);
const third=await post("/staff",seller,{...agreementDraft,agreementId:issued.agreement_id,terms:"Reintroduced third terms."});
await post("/staff",seller,{caseId,action:"agreement-publish",id:third.id});
const declined=(await get("",owner)).agreements.find(row=>row.id===third.id);
await post("",owner,{action:"agreement-decline",id:declined.id,contentHash:declined.content_hash,name:owner.name,consent:false,reason:"Review necessary."});
assert.equal((await get("",owner)).agreements.find(row=>row.id===declined.id).status,"Declined");
await query("CREATE ROLE finance_qa_runtime").run();
await query("GRANT SELECT ON client_invoices,client_agreement_responses TO finance_qa_runtime").run();
await query(`CREATE POLICY finance_qa_tenant ON client_invoices FOR SELECT TO finance_qa_runtime USING(org_id='walshken')
`).run();
await query(`CREATE POLICY finance_qa_owned_invoice ON client_invoices AS RESTRICTIVE FOR SELECT TO finance_qa_runtime USING(
  NULLIF(current_setting('walshken.client_customer_id',true),'') IS NULL OR customer_id=current_setting('walshken.client_customer_id',true))
`).run();
await query(`CREATE POLICY finance_qa_tenant ON client_agreement_responses FOR SELECT TO finance_qa_runtime USING(org_id='walshken')
`).run();
await query(`CREATE POLICY finance_qa_owned_signature ON client_agreement_responses AS RESTRICTIVE FOR SELECT TO finance_qa_runtime USING(
  NULLIF(current_setting('walshken.client_customer_id',true),'') IS NULL OR customer_id=current_setting('walshken.client_customer_id',true))
`).run();
await query("SET ROLE finance_qa_runtime").run();
const selectOwned=tx=>tx.prepare("SELECT (SELECT count(*)::int FROM client_invoices) AS invoices, (SELECT count(*)::int FROM client_agreement_responses) AS signatures",[]).first();
assert.deepEqual(await withClientDb(db,stranger.id,selectOwned),{invoices:0,signatures:0});
assert.deepEqual(await withClientDb(db,owner.id,selectOwned),{invoices:1,signatures:2});
await query("RESET ROLE").run();
await query("SET ROLE anon").run();
await assert.rejects(query("SELECT * FROM client_agreement_responses").run(),/permission denied/);
await query("RESET ROLE").run();
console.log("PASS case-scoped agreement versions, current consent, password confirmation, declines, immutable signed original, and closed anonymous access");

const installmentClient=await customer("Installment client"),installmentCase=randomUUID();
await query(`INSERT INTO client_cases(id,org_id,customer_id,reference,title,service,country,assigned_employee_id,representative_name,created_at,updated_at)
  VALUES(?,'walshken',?,'CASE-INSTALLMENTS','Installment QA case','Immigration','CA',?,'Representative',?,?)`,installmentCase,installmentClient.id,assigned.id,stamp,stamp).run();
const issuedPlanInvoice=await post("/staff",seller,{...base,caseId:installmentCase,
  items:[{description:"Client services",quantity:1,unitMinor:10000,taxBps:0}]});
await post("/staff",seller,{caseId:installmentCase,action:"invoice-issue",id:issuedPlanInvoice.id});
const planInvoice=issuedPlanInvoice.id, planActor=installmentClient, tomorrow=future.slice(0,10);
const nextWeek=new Date(Date.now()+7*86_400_000).toISOString().slice(0,10);
const planInput={action:"payment-plan",caseId:installmentCase,id:planInvoice,mode:"Installments",
  installments:[{dueOn:tomorrow,amountMinor:3000},{dueOn:nextWeek,amountMinor:7000}]};
await post("/staff",assigned,planInput,403);
await post("/staff",seller,{...planInput,installments:[{dueOn:tomorrow,amountMinor:3000},{dueOn:tomorrow,amountMinor:7000}]},400);
await post("/staff",seller,{...planInput,installments:[{dueOn:tomorrow,amountMinor:3000},{dueOn:nextWeek,amountMinor:6900}]},400);
await post("/staff",seller,planInput);
const planBefore=await get("",planActor);
assert.equal(planBefore.invoices[0].payment_plan.mode,"Installments");
assert.equal(planBefore.invoices[0].balance_minor,10000);
assert.deepEqual(planBefore.invoices[0].payment_plan.installments.map(row=>row.balance_minor),[3000,7000]);
assert.equal((await get("",stranger)).invoices.some(row=>row.id===planInvoice),false);
await assert.rejects(query("UPDATE client_payment_installments SET amount_minor=30 WHERE invoice_id=?",planInvoice).run(),/immutable/);
const {remindClientPayments}=await import("../lib/walshken/client-payment-plans.ts");
assert.ok((await remindClientPayments(db)).queued>=1);
assert.equal((await remindClientPayments(db)).queued,0);
assert.equal((await query("SELECT count(*)::int AS n FROM client_notifications WHERE customer_id=? AND type='payment-reminder'",planActor.id).first()).n,1);

const providerSessions=new Map();
let haveFullRefund=false,checkoutCalls=0;
globalThis.fetch=async(url,options)=>{
 if(String(url).startsWith("https://api.stripe.com/v1/payment_intents/")){
   const intent=new URL(url).pathname.split("/").at(-1), checkout=[...providerSessions.values()][Number(intent.at(-1))-1];
   return Response.json({object:"payment_intent",id:intent,status:"succeeded",livemode:false,currency:"cad",amount_received:3000,
     metadata:{walshken_payment_id:checkout.attempt,walshken_invoice_id:checkout.invoice},
     latest_charge:{object:"charge",id:"ch_TestPlan",payment_intent:intent,currency:"cad",livemode:false,
       amount:3000,refunded:true,amount_refunded:3000}});
 }
 if(String(url).startsWith("https://api.stripe.com/v1/refunds?")){
   return Response.json({object:"list",has_more:false,data:[{object:"refund",payment_intent:new URL(url).searchParams.get("payment_intent"),
     charge:"ch_TestPlan",currency:"cad",amount:3000,status:haveFullRefund?"succeeded":"pending"}]});
 }
 assert.equal(url,"https://api.stripe.com/v1/checkout/sessions");
 checkoutCalls++;
 const key=options.headers["Idempotency-Key"],form=options.body;
 if(!providerSessions.has(key)){
  const number=providerSessions.size+1,session="cs_test_Installment"+number,attempt=form.get("metadata[walshken_payment_id]");
  providerSessions.set(key,{id:session,attempt,invoice:form.get("metadata[walshken_invoice_id]"),
    amount:Number(form.get("line_items[0][price_data][unit_amount]")),url:"https://checkout.stripe.com/c/pay/plan"+number,
    expires_at:Math.floor(Date.now()/1000)+3600,livemode:false});
 }
 return Response.json(providerSessions.get(key));
};
async function planWebhook(checkout,type,id,paid,expected=200) {
  const timestamp=Math.floor(Date.now()/1000);
  const body=JSON.stringify({id,type,created:timestamp,livemode:false,data:{object:{id:checkout.id,object:"checkout.session",mode:"payment",
    livemode:false,payment_status:paid?"paid":"unpaid",currency:"cad",amount_total:checkout.amount,payment_intent:"pi_Plan"+checkout.id.at(-1),
    client_reference_id:checkout.attempt,metadata:{walshken_payment_id:checkout.attempt,walshken_invoice_id:checkout.invoice}}}});
  const tag=createHmac("sha256",process.env.WALSHKEN_STRIPE_WEBHOOK_SECRET).update(timestamp+"."+body).digest("hex");
  return (await request("/stripe",null,body,expected,{headers:{"Stripe-Signature":`t=${timestamp},v1=${tag}`}})).json();
}
try {
 await post("",planActor,{action:"checkout",id:planInvoice,amountMinor:2000},403);
 const [first,repeat]=await Promise.all([
  post("",planActor,{action:"checkout",id:planInvoice,payNext:true}),
  post("",planActor,{action:"checkout",id:planInvoice,payNext:true}),
 ]);
 assert.equal(first.url,repeat.url);
 assert.equal(providerSessions.size,1);
 const [stale]=providerSessions.values();
 assert.equal(stale.amount,3000);
 await post("/staff",seller,{...planInput,mode:"Full"},409);
 await planWebhook(stale,"checkout.session.async_payment_failed","evt_InstallmentFailed",false);
 await post("",planActor,{action:"checkout",id:planInvoice,payNext:true});
 const next=[...providerSessions.values()][1];
 assert.equal(next.amount,3000);
 await planWebhook(next,"checkout.session.completed","evt_InstallmentPaid",true);
 assert.equal((await planWebhook(next,"checkout.session.completed","evt_InstallmentPaid",true)).duplicate,true);
 const partly=(await get("",planActor)).invoices[0];
 assert.equal(partly.balance_minor,7000);
 assert.equal(partly.status,"Open");
 assert.equal(partly.paid_minor,3000);
 assert.equal(partly.payment_plan.installments[0].balance_minor,0);
 assert.match((await get("",planActor)).payments.find(row=>row.id===next.attempt).receipt_number,/-01$/);
 assert.deepEqual(await get("?summary=1",planActor),{outstandingInvoices:1,pendingAgreements:0,balances:[{currency:"CAD",amount_minor:"7000",invoices:1}]});
 await post("/staff",seller,{...planInput,mode:"Partial"},409);
 await post("/staff",seller,{action:"invoice-void",caseId:installmentCase,id:planInvoice,reason:"Already partly paid"},409);
 await post("",planActor,{action:"checkout",id:planInvoice});
 const final=[...providerSessions.values()][2];
 assert.equal(final.amount,7000);
 await planWebhook(final,"checkout.session.async_payment_succeeded","evt_InstallmentSettled",true);
 assert.equal((await get("",planActor)).invoices[0].status,"Paid");
 assert.equal((await get("",planActor)).invoices[0].balance_minor,0);
 assert.match((await get("",planActor)).payments.find(row=>row.id===final.attempt).receipt_number,/-02$/);
 const late=await planWebhook(stale,"checkout.session.completed","evt_InstallmentLate",true);
 assert.equal(late.review,true);
 assert.equal((await get("",planActor)).invoices[0].payment_blocked,true);
 await post("/staff",assigned,{action:"payment-reconcile",caseId:installmentCase,id:stale.attempt},403);
 await post("/staff",seller,{action:"payment-reconcile",caseId:installmentCase,id:stale.attempt},409);
 haveFullRefund=true;
 await post("/staff",seller,{action:"payment-reconcile",caseId:installmentCase,id:stale.attempt});
 const resolved=await get("",planActor);
 assert.equal(resolved.invoices[0].payment_blocked,false);
 assert.equal(resolved.payments.find(row=>row.id===stale.attempt).status,"Refunded");
 assert.equal(resolved.invoices[0].paid_minor,10000);

 const partial=await post("/staff",seller,{...base,caseId:installmentCase,
   items:[{description:"Partial QA",quantity:1,unitMinor:8001,taxBps:0}]});
 await post("/staff",seller,{caseId:installmentCase,action:"invoice-issue",id:partial.id});
 await post("",planActor,{action:"checkout",id:partial.id,amountMinor:1100},403);
 await post("/staff",seller,{...planInput,id:partial.id,mode:"Partial"});
 await post("",planActor,{action:"checkout",id:partial.id,amountMinor:8002},400);
 await post("",planActor,{action:"checkout",id:partial.id,amountMinor:1234});
 const partialCheckout=[...providerSessions.values()][3];
 assert.equal(partialCheckout.amount,1234);
 await post("",planActor,{action:"checkout",id:partial.id,amountMinor:1000},409);
 await planWebhook(partialCheckout,"checkout.session.completed","evt_PartialPaid",true);
 assert.equal((await get("",planActor)).invoices.find(row=>row.id===partial.id).balance_minor,6767);
 assert.equal(checkoutCalls>=4,true);
} finally {globalThis.fetch=actualFetch;}
console.log("PASS installment plans, reminders, custom partials, concurrent checkout, exact balance, sequential receipts and authorized Stripe refund reconciliation");
process.exit(0);
