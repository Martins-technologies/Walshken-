import {all,audit,canSuper,date,fail,id,integer,now,one,pick,run,str,type Actor,type Db} from "./server";
import {clientCaseFor,staffCaseFor,notifyCaseStaff,type ClientCase} from "./client-cases";
import {notifyClient} from "./client-notifications";
import {checkoutMode} from "./client-finance-payments";
import {
  agreementColumns,agreementHash,agreementJoins,digestFinance,electronicConsentVersion,financeActivity,financeItemRows,financeTerms,
  invoiceColumns,invoiceCurrencies,type AgreementVersion,type Invoice,type InvoiceItem,type Payment,type SignatureEvidence,
} from "./client-finance-records";

type FinanceScope={customerId:string;orgId:string;caseId?:string};
type FinanceClient={id:string;name:string;email:string;sessionId:string};
const issuerLabel="issuer legal name";
const invoiceJoins="FROM client_invoices i JOIN client_cases c ON c.id=i.case_id AND c.org_id=i.org_id AND c.customer_id=i.customer_id";
const financeKinds=["invoice","receipt","agreement"] as const;

function canManageFinance(actor:Actor) {
  return canSuper(actor)||actor.role==="admin";
}
function caseScope(c:ClientCase):FinanceScope {
  return {customerId:c.customer_id,orgId:c.org_id,caseId:c.id};
}
function scopeArgs(scope:FinanceScope) {
  return [scope.orgId,scope.customerId,scope.caseId??"",scope.caseId??""];
}

export async function clientFinanceSummary(db:Db,scope:FinanceScope) {
  const [balances,agreements]=await Promise.all([
    all<{currency:Invoice["currency"];amount_minor:string;invoices:number}>(db,`SELECT i.currency,SUM(i.total_minor)::text AS amount_minor,COUNT(*)::int AS invoices
      FROM client_invoices i WHERE i.org_id=? AND i.customer_id=? AND (?='' OR i.case_id=?) AND i.status IN ('Open','Processing')
      GROUP BY i.currency ORDER BY i.currency`,...scopeArgs(scope)),
    one<{pending_agreements:number}>(db,`SELECT COUNT(*)::int AS pending_agreements
      FROM client_agreements g JOIN client_agreement_versions v ON v.agreement_id=g.id AND v.org_id=g.org_id
      WHERE g.org_id=? AND g.customer_id=? AND (?='' OR g.case_id=?) AND v.published_at IS NOT NULL AND v.withdrawn_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM client_agreement_responses r WHERE r.version_id=v.id)`,...scopeArgs(scope)),
  ]);
  return {outstandingInvoices:balances.reduce((sum,balance)=>sum+balance.invoices,0),
    pendingAgreements:agreements?.pending_agreements??0,balances};
}

export async function financeView(db:Db,scope:FinanceScope,actor?:Actor) {
  const [invoices,payments,agreements,mode,activity]=await Promise.all([
    all<Invoice>(db,`SELECT ${invoiceColumns} ${invoiceJoins}
      WHERE i.org_id=? AND i.customer_id=? AND (?='' OR i.case_id=?) ${actor?"":"AND i.status<>'Draft'"}
      ORDER BY i.created_at DESC,i.id DESC LIMIT 100`,...scopeArgs(scope)),
    all<Payment>(db,`SELECT p.id,p.invoice_id,i.invoice_number,p.amount_minor,p.currency,p.sandbox,p.status,
      p.provider_reference,p.receipt_number,p.created_at,p.confirmed_at
      FROM client_payments p JOIN client_invoices i ON i.id=p.invoice_id AND i.org_id=p.org_id
      WHERE i.org_id=? AND i.customer_id=? AND (?='' OR i.case_id=?)
      ORDER BY p.created_at DESC,p.id DESC LIMIT 150`,...scopeArgs(scope)),
    all<AgreementVersion>(db,`SELECT ${agreementColumns} ${agreementJoins}
      WHERE g.org_id=? AND g.customer_id=? AND (?='' OR g.case_id=?) ${actor?"":"AND v.published_at IS NOT NULL"}
      ORDER BY v.created_at DESC,v.version DESC LIMIT 100`,...scopeArgs(scope)),
    checkoutMode(db),
    actor?all(db,`SELECT action,entity_id,summary,created_at FROM client_finance_activity
      WHERE org_id=? AND customer_id=? AND case_id=? ORDER BY created_at DESC,id DESC LIMIT 100`,scope.orgId,scope.customerId,scope.caseId):[],
  ]);
  const byInvoice=new Map<string,InvoiceItem[]>();
  for(const {invoice_id,...item} of await financeItemRows(db,invoices.map(row=>row.id))){
    const list=byInvoice.get(invoice_id)??[];list.push(item);byInvoice.set(invoice_id,list);
  }
  return {invoices:invoices.map(row=>({...row,items:byInvoice.get(row.id)??[]})),payments,agreements,checkoutMode:mode,activity,
    ...(actor?{canManage:canManageFinance(actor)}:{})};
}

function invoiceItems(raw:unknown) {
  if(!Array.isArray(raw)||raw.length<1||raw.length>40)return fail(400,"Add between 1 and 40 invoice line items.");
  let subtotal=0,tax=0;
  const items:InvoiceItem[]=raw.map((value,position)=>{
    if(!value||typeof value!=="object"||Array.isArray(value))return fail(400,"Enter valid invoice line items.");
    const description=financeTerms(value.description,"line item description",250),quantity=integer(value.quantity,"quantity",1,10000);
    const unit=integer(value.unitMinor,"unit price in minor currency units",0,99_999_999), taxBps=integer(value.taxBps??0,"tax percentage",0,10000);
    const subtotalMinor=quantity*unit;
    if(subtotalMinor>99_999_999)return fail(400,"An invoice line exceeds the maximum payable total.");
    const taxMinor=Math.floor((subtotalMinor*taxBps+5000)/10000);
    subtotal+=subtotalMinor;tax+=taxMinor;
    return {position:position+1,description,quantity,unit_minor:unit,tax_bps:taxBps,subtotal_minor:subtotalMinor,tax_minor:taxMinor,total_minor:subtotalMinor+taxMinor};
  });
  if(subtotal<=0||subtotal+tax>99_999_999)return fail(400,"Invoice total must be positive and within the supported amount.");
  return {items,subtotal,tax,total:subtotal+tax};
}

async function invoiceFor(db:Db,scope:FinanceScope,target:string,lock=false) {
  const invoice=await one<Invoice>(db,`SELECT ${invoiceColumns} ${invoiceJoins} WHERE i.id=? AND i.org_id=? AND i.customer_id=?
    AND (?='' OR i.case_id=?) ${lock?"FOR UPDATE OF i":""}`,target,...scopeArgs(scope));
  if(!invoice)return fail(404,"Invoice unavailable.");
  return invoice;
}

async function agreementFor(db:Db,scope:FinanceScope,target:string,lock=false) {
  const version=await one<AgreementVersion>(db,`SELECT ${agreementColumns} ${agreementJoins} WHERE v.id=? AND g.org_id=? AND g.customer_id=?
    AND (?='' OR g.case_id=?) ${lock?"FOR UPDATE OF v":""}`,target,...scopeArgs(scope));
  if(!version)return fail(404,"Agreement version unavailable.");
  if(agreementHash(version)!==version.content_hash)return fail(409,"The agreement version failed its integrity check.");
  return version;
}

async function writeFinanceAudit(db:Db,actor:Actor,c:ClientCase,action:string,target:string,summary:string) {
  await financeActivity(db,c,actor.id,action,target,summary);
  await audit(db,actor,action,"client finance",target).run();
}

export async function staffFinanceAction(db:Db,actor:Actor,data:Record<string,unknown>) {
  if(!canManageFinance(actor))return fail(403,"Only an authorized case administrator can manage invoices or agreements.");
  const caseId=str(data.caseId,"case",80);
  return db.transaction(async tx=>{
    const c=await staffCaseFor(tx,actor,caseId,true),scope=caseScope(c),at=now();
    const action=pick(data.action,["invoice-save","invoice-issue","invoice-void","agreement-save","agreement-publish","agreement-withdraw"] as const,"finance action");
    if(action==="invoice-save"){
      const {items,subtotal,tax,total}=invoiceItems(data.items);
      const due=date(data.dueOn,"invoice due date")!, currency=pick(data.currency,invoiceCurrencies,"invoice currency");
      const issuer=[financeTerms(data.issuerName,issuerLabel,180),financeTerms(data.issuerAddress,"issuer address",500),financeTerms(data.issuerTaxNumber,"issuer tax number",100,false)];
      const key=str(data.id,"invoice",80,false)||id();
      const customer=await one<{name:string;email:string}>(tx,"SELECT name,email FROM customers WHERE id=?",c.customer_id);
      if(!customer)return fail(404,"Client unavailable.");
      if(data.id){
        const invoice=await invoiceFor(tx,scope,key,true);
        if(invoice.status!=="Draft")return fail(409,"Issued invoices are locked. Void an unpaid invoice and create a replacement if needed.");
        await run(tx,`UPDATE client_invoices SET issuer_name=?,issuer_address=?,issuer_tax_number=?,recipient_name=?,recipient_email=?,
          currency=?,due_on=?,subtotal_minor=?,tax_minor=?,total_minor=?,updated_at=? WHERE id=?`,
          ...issuer,customer.name,customer.email,currency,due,subtotal,tax,total,at,key);
        await run(tx,"DELETE FROM client_invoice_items WHERE org_id=? AND invoice_id=?",c.org_id,key);
      }else{
        await run(tx,`INSERT INTO client_invoices(id,org_id,case_id,customer_id,issuer_name,issuer_address,issuer_tax_number,recipient_name,recipient_email,
          currency,due_on,subtotal_minor,tax_minor,total_minor,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          key,c.org_id,c.id,c.customer_id,...issuer,customer.name,customer.email,currency,due,subtotal,tax,total,actor.id,at,at);
      }
      for(const item of items){
        await run(tx,`INSERT INTO client_invoice_items(org_id,invoice_id,position,description,quantity,unit_minor,tax_bps,subtotal_minor,tax_minor,total_minor)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,c.org_id,key,item.position,item.description,item.quantity,item.unit_minor,item.tax_bps,item.subtotal_minor,item.tax_minor,item.total_minor);
      }
      await writeFinanceAudit(tx,actor,c,"Invoice draft saved",key,"Saved a draft invoice with "+items.length+" line items.");
      return {id:key,message:"Invoice draft saved."};
    }
    if(action==="invoice-issue"||action==="invoice-void"){
      const invoice=await invoiceFor(tx,scope,str(data.id,"invoice",80),true);
      if(action==="invoice-issue"){
        if(invoice.status!=="Draft")return fail(409,"Only draft invoices can be issued.");
        const issueOn=at.slice(0,10),year=Number(issueOn.slice(0,4));
        if(invoice.due_on<issueOn)return fail(400,"The payment due date must be on or after the issue date.");
        const sequence=await one<{last_number:number}>(tx,`INSERT INTO client_invoice_sequences(org_id,issue_year,last_number) VALUES (?,?,1)
          ON CONFLICT (org_id,issue_year) DO UPDATE SET last_number=client_invoice_sequences.last_number+1 RETURNING last_number`,c.org_id,year);
        const number=`WAL-${year}-${String(sequence!.last_number).padStart(6,"0")}`;
        await run(tx,"UPDATE client_invoices SET invoice_number=?,issue_on=?,status='Open',updated_at=? WHERE id=?",number,issueOn,at,invoice.id);
        await writeFinanceAudit(tx,actor,c,"Invoice issued",invoice.id,number+" was issued to the client.");
        await notifyClient(tx,c.customer_id,{type:"invoice",title:"Invoice available",body:`${number} is available in Payments & Invoices. Payment is due ${invoice.due_on}.`,
          href:"/customer/payments",dedupeKey:"invoice-issued:"+invoice.id});
        return {id:invoice.id,message:"Invoice issued and the client was notified."};
      }
      if(invoice.status!=="Open"||await one(tx,"SELECT id FROM client_payments WHERE invoice_id=? AND status IN ('Creating','Pending','Processing','Paid')",invoice.id)){
        return fail(409,"Only an unpaid invoice with no active checkout can be voided.");
      }
      const reason=financeTerms(data.reason,"void reason",500);
      await run(tx,"UPDATE client_invoices SET status='Void',void_reason=?,updated_at=? WHERE id=?",reason,at,invoice.id);
      await writeFinanceAudit(tx,actor,c,"Invoice voided",invoice.id,reason);
      await notifyClient(tx,c.customer_id,{type:"invoice",title:"Invoice voided",body:invoice.invoice_number+" was voided and no payment is due.",href:"/customer/payments",dedupeKey:"invoice-voided:"+invoice.id});
      return {id:invoice.id,message:"Invoice voided."};
    }
    if(action==="agreement-save"){
      const group=str(data.agreementId,"agreement",80,false)||id();
      if(data.agreementId){
        if(!await one(tx,"SELECT id FROM client_agreements WHERE id=? AND org_id=? AND case_id=? AND customer_id=?",group,c.org_id,c.id,c.customer_id))return fail(404,"Agreement unavailable.");
      }else await run(tx,"INSERT INTO client_agreements(id,org_id,case_id,customer_id,created_by,created_at) VALUES (?,?,?,?,?,?)",group,c.org_id,c.id,c.customer_id,actor.id,at);
      const newest=await one<{version:number}>(tx,"SELECT version FROM client_agreement_versions WHERE agreement_id=? ORDER BY version DESC LIMIT 1",group);
      const version={
        id:id(),agreement_id:group,version:(newest?.version??0)+1,title:financeTerms(data.title,"agreement title",150),
        issuer_name:financeTerms(data.issuerName,issuerLabel,180),terms:financeTerms(data.terms,"terms and conditions",20000),
        undertakings:financeTerms(data.undertakings,"undertakings",5000,false),
      };
      await run(tx,`INSERT INTO client_agreement_versions(id,org_id,agreement_id,version,title,issuer_name,terms,undertakings,content_hash,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,version.id,c.org_id,group,version.version,version.title,version.issuer_name,version.terms,version.undertakings,agreementHash(version),actor.id,at);
      await writeFinanceAudit(tx,actor,c,"Agreement version drafted",version.id,`Created agreement version ${version.version}.`);
      return {id:version.id,message:"New agreement version saved as a draft."};
    }
    const version=await agreementFor(tx,scope,str(data.id,"agreement version",80),true);
    if(action==="agreement-publish"){
      if(version.status!=="Draft"||await one(tx,"SELECT id FROM client_agreement_versions WHERE agreement_id=? AND version>? LIMIT 1",version.agreement_id,version.version)){
        return fail(409,"Publish the most recent draft version.");
      }
      const prior=await all<{id:string}>(tx,`SELECT v.id FROM client_agreement_versions v
        WHERE v.agreement_id=? AND v.published_at IS NOT NULL AND v.withdrawn_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM client_agreement_responses r WHERE r.version_id=v.id)`,version.agreement_id);
      for(const row of prior){
        await run(tx,"UPDATE client_agreement_versions SET withdrawn_at=?,withdrawn_by=?,withdrawal_reason=? WHERE id=?",at,actor.id,"Superseded by a newly published version.",row.id);
        await writeFinanceAudit(tx,actor,c,"Agreement version superseded",row.id,`Superseded by version ${version.version}.`);
      }
      await run(tx,"UPDATE client_agreement_versions SET published_at=?,published_by=? WHERE id=?",at,actor.id,version.id);
      await writeFinanceAudit(tx,actor,c,"Agreement issued",version.id,`Published approved agreement version ${version.version}.`);
      await notifyClient(tx,c.customer_id,{type:"agreement",title:"Agreement ready to review",body:version.title+" is available to review and sign in the client portal.",
        href:"/customer/agreements",dedupeKey:"agreement-issued:"+version.id});
      return {id:version.id,message:"Agreement published and a signature requested."};
    }
    if(version.status!=="Issued")return fail(409,"Only an unsigned, issued agreement can be withdrawn.");
    const reason=financeTerms(data.reason,"withdrawal reason",500);
    await run(tx,"UPDATE client_agreement_versions SET withdrawn_at=?,withdrawn_by=?,withdrawal_reason=? WHERE id=?",at,actor.id,reason,version.id);
    await writeFinanceAudit(tx,actor,c,"Agreement withdrawn",version.id,reason);
    await notifyClient(tx,c.customer_id,{type:"agreement",title:"Agreement withdrawn",body:version.title+" is no longer awaiting a signature.",href:"/customer/agreements",dedupeKey:"agreement-withdrawn:"+version.id});
    return {id:version.id,message:"Agreement version withdrawn."};
  });
}

export async function clientAgreementAction(db:Db,actor:FinanceClient,scope:FinanceScope,data:Record<string,unknown>) {
  const action=pick(data.action,["agreement-sign","agreement-decline"] as const,"agreement decision");
  const target=str(data.id,"agreement version",80), presented=str(data.contentHash,"agreement fingerprint",64);
  const signed=action==="agreement-sign";
  const signedName=financeTerms(data.name??(!signed?actor.name:undefined),"full signing name",160).replace(/\s+/gu," ");
  if(signed&&(data.consent!==true||signedName.toLocaleLowerCase("en")!==actor.name.normalize("NFC").trim().replace(/\s+/gu," ").toLocaleLowerCase("en"))){
    return fail(400,"Enter the full name saved to your verified account and accept the electronic signature consent.");
  }
  const reason=signed?null:financeTerms(data.reason,"reason for declining",500,false)||null;
  return db.transaction(async tx=>{
    const state=await agreementFor(tx,scope,target);
    const c=await clientCaseFor(tx,actor.id,state.case_id,true);
    const version=await agreementFor(tx,scope,target,true);
    if (!version.published_at)return fail(404,"Agreement version unavailable.");
    if(version.status!=="Issued"||presented!==version.content_hash)return fail(409,"This version is no longer ready to sign. Refresh the latest agreement.");
    const evidence:SignatureEvidence={signer_name:signedName,signer_email:actor.email,consent_version:electronicConsentVersion,responded_at:now(),
      session_hash:digestFinance(actor.sessionId)};
    const pdf=signed?await (await import("./client-finance-pdf")).agreementPdf(version,evidence):null;
    await run(tx,`INSERT INTO client_agreement_responses(version_id,org_id,customer_id,content_hash,decision,signer_name,signer_email,session_hash,
      consent_version,consent,reason,responded_at,signed_pdf,signed_pdf_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      version.id,c.org_id,actor.id,version.content_hash,signed?"Signed":"Declined",evidence.signer_name,evidence.signer_email,evidence.session_hash,evidence.consent_version,
      signed,reason,evidence.responded_at,pdf?Buffer.from(pdf):null,pdf?digestFinance(pdf):null);
    await financeActivity(tx,c,null,signed?"Agreement signed":"Agreement declined",version.id,`The verified client responded to agreement version ${version.version}.`);
    await notifyClient(tx,actor.id,{type:"agreement",title:signed?"Signed copy available":"Agreement declined",
      body:signed?"Your signed copy of "+version.title+" is ready to download.":version.title+" was declined.",
      href:"/customer/agreements",dedupeKey:"agreement-response:"+version.id});
    await notifyCaseStaff(tx,c,signed?"Client signed an agreement":"Client declined an agreement",
      c.reference+" has an agreement response. Open the case to review it.","agreement-response:"+version.id);
    return {id:version.id,message:signed?"Agreement signed. Your signed copy is ready.":"Agreement declined."};
  });
}

export async function financeDownload(db:Db,scope:FinanceScope,params:URLSearchParams,actor?:Actor) {
  const {financePdfResponse,invoicePdf,agreementPdf}=await import("./client-finance-pdf");
  const kind=pick(params.get("kind"),financeKinds,"file type"),target=str(params.get("id"),"record",80);
  if(kind==="agreement"){
    const version=await agreementFor(db,scope,target);
    if(!actor&&!version.published_at)return fail(404,"Agreement version unavailable.");
    if(version.status==="Signed"){
      const signed=await one<{signed_pdf:Uint8Array;signed_pdf_hash:string}>(db,`SELECT signed_pdf,signed_pdf_hash FROM client_agreement_responses
        WHERE version_id=? AND org_id=? AND customer_id=? AND decision='Signed'`,version.id,version.org_id,version.customer_id);
      if(!signed||digestFinance(signed.signed_pdf)!==signed.signed_pdf_hash)return fail(409,"The signed copy failed its integrity check.");
      return financePdfResponse(signed.signed_pdf,"walshken-signed-agreement-v"+version.version);
    }
    return financePdfResponse(await agreementPdf(version),"walshken-agreement-v"+version.version);
  }
  const payment=kind==="receipt"?await one<Payment>(db,`SELECT p.*,i.invoice_number FROM client_payments p
    JOIN client_invoices i ON i.id=p.invoice_id AND i.org_id=p.org_id WHERE p.id=? AND i.org_id=? AND i.customer_id=?
      AND (?='' OR i.case_id=?) AND p.status='Paid'`,target,...scopeArgs(scope)):null;
  if(kind==="receipt"&&!payment)return fail(404,"Verified payment receipt unavailable.");
  const invoice=await invoiceFor(db,scope,payment?.invoice_id??target);
  if(invoice.status==="Draft"||!invoice.invoice_number)return fail(404,"The invoice PDF is available after issuing.");
  const list=await financeItemRows(db,[invoice.id]);
  return financePdfResponse(await invoicePdf(invoice,list,payment??undefined),payment?.receipt_number??invoice.invoice_number);
}
