import {createHmac,timingSafeEqual} from "node:crypto";
import {withClientDb} from "./client-feature";
import {integrationSettings} from "./integration-settings";
import {AppError,fail,id,integer,now,one,orgId,run,type Db} from "./server";
import {notifyClient} from "./client-notifications";
import {notifyCaseStaff} from "./client-cases";
import {clientPaymentSchedules,paidOnInvoice} from "./client-payment-plans";
import {digestFinance,financeActivity,invoiceColumns,type CaseFinance,type Invoice,type Payment} from "./client-finance-records";

type CheckoutConfig={apiKey:string;webhookSecret:string;sandbox:boolean};
type CheckoutResult={id:string;url:string;expiresAt:string};
type CheckoutEvent={id:string;type:string;digest:string;sandbox:boolean;createdAt:string;session:Record<string,unknown>};
const checkoutEvents=["checkout.session.completed","checkout.session.async_payment_succeeded","checkout.session.async_payment_failed","checkout.session.expired"];

function stripeOptions(settings:Record<string,string>):CheckoutConfig|null {
  const {apiKey="",webhookSecret=""}=settings;
  if(!/^sk_(test|live)_[A-Za-z0-9_-]{12,}$/.test(apiKey)||!/^whsec_[A-Za-z0-9_-]{12,}$/.test(webhookSecret))return null;
  const sandbox=apiKey.startsWith("sk_test_");
  const production=process.env.VERCEL_ENV==="production";
  if((sandbox&&production)||(!sandbox&&(!production||process.env.WALSHKEN_STRIPE_MODE!=="live")))return null;
  return {apiKey,webhookSecret,sandbox};
}
export function validateStripeSettings(settings:Record<string,string>) {
  const config=stripeOptions(settings);
  if(!config)return fail(400,"Enter a Stripe key and webhook secret that match this deployment’s allowed payment mode.");
  return config;
}
export async function verifyStripeConnection(settings:Record<string,string>) {
  const config=validateStripeSettings(settings);
  const response=await fetch("https://api.stripe.com/v1/balance",{
    headers:{authorization:"Bearer "+config.apiKey},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(8000),
  }).catch(()=>null);
  const data=response?.ok?await response.json().catch(()=>null):null;
  if(data?.object!=="balance"||data.livemode!==!config.sandbox)return fail(502,"Stripe did not verify the server key for this mode.");
  return {sandbox:config.sandbox};
}
async function stripeConfig(db:Db):Promise<CheckoutConfig|null> {
  const saved=await integrationSettings(db,"stripe");
  const row=saved?null:await one(db,"SELECT id FROM integrations WHERE id='stripe'");
  if(row)return null;
  return stripeOptions(saved??{apiKey:process.env.WALSHKEN_STRIPE_SECRET_KEY??"",webhookSecret:process.env.WALSHKEN_STRIPE_WEBHOOK_SECRET??""});
}
export async function checkoutMode(db:Db) {
  try {
    const config=await stripeConfig(db);
    return config?(config.sandbox?"sandbox":"live"):"unconfigured";
  }catch(error){
    if(error instanceof AppError&&error.status===503)return "unconfigured";
    throw error;
  }
}

function checkoutOrigin(request:Request) {
  const previewOrigins=[process.env.VERCEL_URL,process.env.VERCEL_BRANCH_URL].filter(Boolean).map(host=>"https://"+host);
  const caller=request.headers.get("origin");
  const configured=process.env.VERCEL_ENV==="preview"
    ? caller&&previewOrigins.includes(caller)?caller:previewOrigins[0]
    : process.env.WALSHKEN_CLIENT_ORIGIN??process.env.WALSHKEN_STAFF_EMAIL_ORIGIN;
  let base:URL;
  try { base=new URL(configured||request.url); } catch { return fail(503,"The secure payment return address is unavailable."); }
  if(base.username||base.password||(base.protocol!=="https:"&&!(process.env.NODE_ENV!=="production"&&base.hostname==="localhost"))){
    return fail(503,"The secure payment return address is invalid.");
  }
  return base.origin;
}

async function createStripe(config:CheckoutConfig,attempt:Payment,invoice:Invoice,origin:string):Promise<CheckoutResult> {
  const returned=(status:string)=>new URL("/customer/payments?checkout="+status,origin).href;
  const metadata={walshken_payment_id:attempt.id,walshken_invoice_id:invoice.id};
  const form=new URLSearchParams({
    mode:"payment",success_url:returned("return"),cancel_url:returned("cancel"),
    client_reference_id:attempt.id,"payment_method_types[0]":"card",
    "line_items[0][price_data][currency]":invoice.currency.toLowerCase(),
    "line_items[0][price_data][product_data][name]":"Walshken invoice "+invoice.invoice_number,
    "line_items[0][price_data][unit_amount]":String(attempt.amount_minor),
    "line_items[0][quantity]":"1",
  });
  for(const [key,value] of Object.entries(metadata)){
    form.set(`metadata[${key}]`,value);
    form.set(`payment_intent_data[metadata][${key}]`,value);
  }
  const response=await fetch("https://api.stripe.com/v1/checkout/sessions",{
    method:"POST",headers:{authorization:"Bearer "+config.apiKey,"Idempotency-Key":"walshken-client-"+attempt.id},
    body:form,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12_000),
  }).catch(()=>null);
  if(!response?.ok){
    if(response&&[400,401,403].includes(response.status))return fail(422,"Stripe could not start this payment. Contact your representative if it continues.");
    return fail(503,"Stripe could not confirm the checkout link. Try again to resume the same payment attempt.");
  }
  const session=await response.json().catch(()=>null) as Record<string,unknown>|null;
  const url=typeof session?.url==="string"?parseCheckoutUrl(session.url):null;
  const expires=typeof session?.expires_at==="number"?session.expires_at:0;
  if(!url||typeof session?.id!=="string"||!stripeSessionId(session.id)||!Number.isSafeInteger(expires)||expires<=0||session.livemode!==!config.sandbox){
    return fail(503,"Stripe did not return a usable checkout session.");
  }
  return {id:session.id,url,expiresAt:new Date(expires*1000).toISOString()};
}

function parseCheckoutUrl(value:string) {
  try {
    const url=new URL(value);
    return url.protocol==="https:"&&url.hostname==="checkout.stripe.com"&&!url.username&&!url.password&&!url.port?url.href:null;
  } catch { return null; }
}
const stripeSessionId=(value:string)=>/^cs_(?:test|live)_[A-Za-z0-9]+$/.test(value);

function caseEvidence(invoice:Invoice):CaseFinance {
  return {id:invoice.case_id,org_id:invoice.org_id,customer_id:invoice.customer_id,reference:invoice.case_reference};
}
const invoiceJoin=`FROM client_invoices i JOIN client_cases c ON c.id=i.case_id AND c.org_id=i.org_id AND c.customer_id=i.customer_id`;

export async function createCheckout(db:Db,request:Request,customerId:string,invoiceId:string,choice:{amountMinor?:unknown;payNext?:unknown}={}) {
  const config=await stripeConfig(db);
  if(!config)return fail(503,"Online payment is awaiting company configuration.");
  const origin=checkoutOrigin(request);
  const {attempt,invoice}=await withClientDb(db,customerId,async tx=>{
    const invoice=await one<Invoice>(tx,`SELECT ${invoiceColumns} ${invoiceJoin} WHERE i.id=? AND i.org_id=? AND i.customer_id=? AND i.status<>'Draft' FOR UPDATE OF i`,invoiceId,orgId,customerId);
    if(!invoice)return fail(404,"Invoice unavailable.");
    if(invoice.status!=="Open")return fail(409,"This invoice is not currently payable. Refresh to see its latest status.");
    if(await one(tx,"SELECT id FROM client_payments WHERE org_id=? AND invoice_id=? AND status='Review' LIMIT 1",invoice.org_id,invoice.id)){
      return fail(409,"A payment needs review. Contact Walshken before making another payment.");
    }
    const paid=await paidOnInvoice(tx,invoice),balance=invoice.total_minor-paid.amount;
    if(balance<=0)return fail(409,"This invoice already has a verified full payment.");
    let amount=balance;
    const explicit=choice.amountMinor!==undefined||choice.payNext===true;
    if(explicit){
      const schedule=(await clientPaymentSchedules(tx,[invoice.id],new Map([[invoice.id,paid.amount]]))).get(invoice.id);
      if(choice.payNext===true){
        if(choice.amountMinor!==undefined||schedule?.mode!=="Installments")return fail(400,"This invoice does not have a payable installment.");
        const next=schedule.installments.find(item=>item.balance_minor>0);
        if(!next)return fail(409,"Every installment has been paid.");
        amount=next.balance_minor;
      }else{
        if(schedule?.mode!=="Partial")return fail(403,"The company has not enabled custom partial payments for this invoice.");
        amount=integer(choice.amountMinor,"payment amount in minor currency units",1,balance);
      }
    }
    let attempt=await one<Payment>(tx,`SELECT * FROM client_payments WHERE org_id=? AND invoice_id=? AND status IN ('Creating','Pending','Processing')`,invoice.org_id,invoice.id);
    if(attempt&&(attempt.sandbox!==config.sandbox||!["Creating","Pending"].includes(attempt.status))){
      return fail(409,"Another payment for this invoice is already in progress.");
    }
    if(attempt&&explicit&&attempt.amount_minor!==amount)return fail(409,"Continue the existing checkout before choosing another payment amount.");
    if(!attempt){
      const key=id(),at=now();
      attempt=(await one<Payment>(tx,`INSERT INTO client_payments
        (id,org_id,invoice_id,amount_minor,currency,provider,sandbox,status,created_at,updated_at)
        VALUES (?,?,?,?,?,'stripe',?,'Creating',?,?) RETURNING *`,key,invoice.org_id,invoice.id,amount,invoice.currency,config.sandbox,at,at))!;
      await financeActivity(tx,caseEvidence(invoice),null,"Checkout requested",attempt.id,"Requested secure payment for "+invoice.invoice_number+".");
    }
    return {attempt,invoice};
  });

  if(attempt.status==="Pending"&&attempt.checkout_url){
    if(attempt.expiry_at&&attempt.expiry_at<=now())return fail(409,"The payment link has expired. Wait for Stripe to confirm expiry before trying again.");
    const link=parseCheckoutUrl(attempt.checkout_url);
    if(link)return {url:link};
  }
  let session:CheckoutResult;
  try {session=await createStripe(config,attempt,invoice,origin);}
  catch(error){
    if(error&&typeof error==="object"&&"status" in error&&error.status===422){
      await withClientDb(db,customerId,tx=>run(tx,"UPDATE client_payments SET status='Failed',updated_at=? WHERE id=? AND status='Creating' AND provider_session IS NULL",now(),attempt.id));
    }
    throw error;
  }
  const changed=await withClientDb(db,customerId,tx=>run(tx,`UPDATE client_payments SET status='Pending',provider_session=?,checkout_url=?,expiry_at=?,updated_at=?
    WHERE id=? AND org_id=? AND (provider_session IS NULL OR provider_session=?) AND status IN ('Creating','Pending')`,
    session.id,session.url,session.expiresAt,now(),attempt.id,invoice.org_id,session.id));
  if(changed.count!==1)return fail(409,"The payment changed while opening Stripe. Refresh the invoice.");
  return {url:session.url};
}

export async function webhookBody(request:Request) {
  const max=262_144;
  if(Number(request.headers.get("content-length"))>max)return fail(413,"The webhook is too large.");
  if(!request.body)return fail(400,"The webhook body is missing.");
  const chunks:Uint8Array[]=[], reader=request.body.getReader();
  let size=0;
  try {
    for(;;){
      const {value,done}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>max){await reader.cancel();return fail(413,"The webhook is too large.");}
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  return Buffer.concat(chunks,size);
}

export function verifyStripeEvent(raw:Buffer,header:string,config:CheckoutConfig):CheckoutEvent|null {
  const pairs=header.split(",").map(item=>item.trim().split("="));
  const stamps=pairs.filter(pair=>pair[0]==="t");
  const stamp=stamps[0]?.[1]??"";
  const signatures=pairs.filter(pair=>pair[0]==="v1").map(pair=>pair[1]);
  if(stamps.length!==1||!/^\d{10}$/.test(stamp)||Math.abs(Date.now()/1000-Number(stamp))>300||signatures.length>10){
    return fail(400,"Invalid Stripe webhook signature.");
  }
  const digest=createHmac("sha256",config.webhookSecret).update(stamp+".").update(raw).digest();
  if(!signatures.some(value=>value&&/^[a-f0-9]{64}$/i.test(value)&&timingSafeEqual(Buffer.from(value,"hex"),digest))){
    return fail(400,"Invalid Stripe webhook signature.");
  }
  let event:Record<string,unknown>;
  try {event=JSON.parse(raw.toString("utf8"));} catch {return fail(400,"Invalid Stripe webhook payload.");}
  if(!event||typeof event!=="object"||typeof event.id!=="string"||!/^evt_[A-Za-z0-9]+$/.test(event.id)||
     typeof event.type!=="string"||event.livemode!==!config.sandbox)return fail(400,"Invalid Stripe event identity or mode.");
  if(!checkoutEvents.includes(event.type))return null;
  const created=event.created;
  if(typeof created!=="number"||!Number.isSafeInteger(created)||created<=0||created>(Date.now()+300_000)/1000)return fail(400,"Invalid Stripe event time.");
  const data=event.data as {object?:unknown}|undefined, session=data?.object;
  if(!session||typeof session!=="object"||Array.isArray(session))return fail(400,"Invalid Stripe session data.");
  return {id:event.id,type:event.type,digest:digestFinance(raw),sandbox:config.sandbox,createdAt:new Date(created*1000).toISOString(),session:session as Record<string,unknown>};
}

export async function applyCheckoutWebhook(db:Db,request:Request) {
  const config=await stripeConfig(db);
  if(!config)return fail(503,"Stripe webhooks are awaiting company configuration.");
  const raw=await webhookBody(request);
  const event=verifyStripeEvent(raw,request.headers.get("stripe-signature")??"",config);
  if(!event)return {received:true,ignored:true};
  const session=event.session,metadata=session.metadata as Record<string,unknown>|undefined;
  if(!metadata?.walshken_payment_id&&!metadata?.walshken_invoice_id)return {received:true,ignored:true};
  const paymentId=metadata.walshken_payment_id,invoiceId=metadata.walshken_invoice_id;
  const sessionId=session.id,reference=session.payment_intent;
  if(typeof paymentId!=="string"||typeof invoiceId!=="string"||typeof sessionId!=="string"||!stripeSessionId(sessionId)||
     session.mode!=="payment"||session.object!=="checkout.session"||session.livemode!==!event.sandbox||
     (reference!==null&&(typeof reference!=="string"||!/^pi_[A-Za-z0-9]+$/.test(reference)))||session.client_reference_id!==paymentId){
    return fail(400,"The event does not identify a valid Walshken payment.");
  }

  return db.transaction(async tx=>{
    const invoice=await one<Invoice>(tx,`SELECT ${invoiceColumns} ${invoiceJoin} WHERE i.org_id=? AND i.id=? FOR UPDATE OF i`,orgId,invoiceId);
    const attempt=invoice?await one<Payment>(tx,"SELECT * FROM client_payments WHERE org_id=? AND id=? AND invoice_id=? FOR UPDATE",
      invoice.org_id,paymentId,invoice.id):null;
    if(!invoice||!attempt||attempt.sandbox!==event.sandbox||session.currency!==attempt.currency.toLowerCase()||
       session.amount_total!==attempt.amount_minor||(attempt.provider_session&&attempt.provider_session!==sessionId)||
       (attempt.provider_reference&&reference!==null&&attempt.provider_reference!==reference))return fail(400,"The event does not match the expected invoice and transaction.");
    const added=await one(tx,`INSERT INTO client_payment_events(org_id,provider,event_id,event_type,payload_hash,payment_id,received_at)
      VALUES (?,'stripe',?,?,?,?,?) ON CONFLICT (provider,event_id) DO NOTHING RETURNING event_id`,
      invoice.org_id,event.id,event.type,event.digest,attempt.id,now());
    if(!added){
      const existing=await one<{payload_hash:string;payment_id:string}>(tx,"SELECT payload_hash,payment_id FROM client_payment_events WHERE org_id=? AND provider='stripe' AND event_id=?",invoice.org_id,event.id);
      if(existing?.payload_hash!==event.digest||existing.payment_id!==attempt.id)return fail(409,"A different payload already uses this Stripe event identifier.");
      return {received:true,duplicate:true};
    }
    if(["Paid","Review","Refunded"].includes(attempt.status))return {received:true};
    const successType=event.type==="checkout.session.completed"||event.type==="checkout.session.async_payment_succeeded";
    const paid=successType&&session.payment_status==="paid";
    if(event.type==="checkout.session.async_payment_succeeded"&&!paid)return fail(400,"Stripe did not confirm that the invoice was paid.");
    if(paid){
      if(typeof reference!=="string")return fail(400,"The confirmed payment reference is missing.");
      const settled=await paidOnInvoice(tx,invoice);
      if(invoice.status==="Void"||settled.amount+attempt.amount_minor>invoice.total_minor){
        await run(tx,`UPDATE client_payments SET status='Review',provider_session=?,provider_reference=?,confirmed_at=?,updated_at=? WHERE id=?`,
          sessionId,reference,event.createdAt,now(),attempt.id);
        await financeActivity(tx,caseEvidence(invoice),null,"Payment requires reconciliation",attempt.id,
          "Stripe confirmed a charge that exceeds the outstanding invoice balance or belongs to a void invoice.");
        await notifyClient(tx,invoice.customer_id,{type:"payment",title:"Payment is under review",
          body:`A payment for ${invoice.invoice_number} requires reconciliation. Do not pay again while the company reviews it.`,
          href:"/customer/payments",dedupeKey:"payment-review:"+attempt.id});
        const caseOwner=await one<{assigned_employee_id:string|null}>(tx,"SELECT assigned_employee_id FROM client_cases WHERE id=? AND org_id=?",invoice.case_id,invoice.org_id);
        if(caseOwner)await notifyCaseStaff(tx,{...caseEvidence(invoice),...caseOwner},"Client payment needs finance review",
          "Contact an authorized finance administrator to reconcile the Stripe charge.","payment-review:"+attempt.id);
        return {received:true,review:true};
      }
      const receipt="RCP-"+invoice.invoice_number+(attempt.amount_minor===invoice.total_minor
        ? "" : "-"+String(settled.count+1).padStart(2,"0"));
      await run(tx,`UPDATE client_payments SET status='Paid',provider_session=?,provider_reference=?,receipt_number=?,confirmed_at=?,updated_at=? WHERE id=?`,
        sessionId,reference,receipt,event.createdAt,now(),attempt.id);
      const complete=settled.amount+attempt.amount_minor===invoice.total_minor;
      const stillProcessing=await one(tx,"SELECT id FROM client_payments WHERE invoice_id=? AND status='Processing' LIMIT 1",invoice.id);
      await run(tx,"UPDATE client_invoices SET status=?,updated_at=? WHERE id=?",
        complete?"Paid":stillProcessing?"Processing":"Open",now(),invoice.id);
      await financeActivity(tx,caseEvidence(invoice),null,"Payment verified",attempt.id,complete
        ?"Signed Stripe webhook verified the payment and settled the invoice."
        :"Signed Stripe webhook verified a partial payment and its receipt.");
      await notifyClient(tx,invoice.customer_id,{type:"payment",title:event.sandbox?"Sandbox payment verified":"Payment confirmed",
        body:`${invoice.invoice_number} has a verified receipt${event.sandbox?" in Stripe test mode":""}.`,
        href:"/customer/payments",dedupeKey:"payment-confirmed:"+attempt.id});
    }else if(!["Failed","Expired"].includes(attempt.status)){
      const status=event.type==="checkout.session.expired"?"Expired":event.type==="checkout.session.async_payment_failed"?"Failed":"Processing";
      await run(tx,`UPDATE client_payments SET status=?,provider_session=?,provider_reference=COALESCE(?,provider_reference),updated_at=? WHERE id=?`,
        status,sessionId,reference,now(),attempt.id);
      if(invoice.status==="Open"||invoice.status==="Processing"){
        const active=await one(tx,"SELECT id FROM client_payments WHERE invoice_id=? AND status='Processing' LIMIT 1",invoice.id);
        await run(tx,"UPDATE client_invoices SET status=?,updated_at=? WHERE id=?",active?"Processing":"Open",now(),invoice.id);
      }
      if(status==="Failed")await notifyClient(tx,invoice.customer_id,{type:"payment",title:"Payment unsuccessful",
        body:"Stripe could not complete the payment for "+invoice.invoice_number+". Review your invoice to retry.",href:"/customer/payments",dedupeKey:"payment-failed:"+attempt.id});
    }
    return {received:true};
  });
}

export async function verifyStripeRefund(db:Db,payment:Payment) {
  const config=await stripeConfig(db),reference=payment.provider_reference;
  if(!config||config.sandbox!==payment.sandbox)return fail(503,"Connect Stripe in the correct payment mode before verifying a refund.");
  if(!reference||!/^pi_[A-Za-z0-9]+$/.test(reference))return fail(409,"This payment has no Stripe reference to verify.");
  const endpoint=new URL("https://api.stripe.com/v1/payment_intents/"+reference);
  endpoint.searchParams.set("expand[]","latest_charge");
  const refundsEndpoint=new URL("https://api.stripe.com/v1/refunds");
  refundsEndpoint.searchParams.set("payment_intent",reference);
  refundsEndpoint.searchParams.set("limit","100");
  async function stripeRead(url:URL) {
    const response=await fetch(url,{
      headers:{authorization:"Bearer "+config!.apiKey},redirect:"error",cache:"no-store",signal:AbortSignal.timeout(8_000),
    }).catch(()=>null);
    if(!response?.ok)return fail(503,"Stripe did not verify the payment status. Try again shortly.");
    return response.json().catch(()=>null);
  }
  const [intent,refunds]=await Promise.all([stripeRead(endpoint),stripeRead(refundsEndpoint)]),charge=intent?.latest_charge;
  const currency=payment.currency.toLowerCase();
  const totalSucceeded=refunds?.object==="list"&&refunds.has_more===false&&Array.isArray(refunds.data)
    ? refunds.data.reduce((total:number,current:unknown)=>{
      if(!current||typeof current!=="object")return total;
      const refund=current as Record<string,unknown>;
      if(refund.object!=="refund"||refund.payment_intent!==reference||refund.charge!==charge?.id||
        refund.currency!==currency||refund.status!=="succeeded"||typeof refund.amount!=="number"||
        !Number.isSafeInteger(refund.amount)||refund.amount<=0)return total;
      return total+refund.amount;
    },0)
    : 0;
  if(intent?.object!=="payment_intent"||intent.id!==reference||intent.status!=="succeeded"||intent.livemode!==!payment.sandbox||
    intent.currency!==currency||intent.amount_received!==payment.amount_minor||intent.metadata?.walshken_payment_id!==payment.id||
    intent.metadata?.walshken_invoice_id!==payment.invoice_id||charge?.object!=="charge"||typeof charge.id!=="string"||
    charge.payment_intent!==reference||charge.currency!==currency||charge.livemode!==intent.livemode||charge.amount!==payment.amount_minor||
    charge.refunded!==true||charge.amount_refunded!==payment.amount_minor||totalSucceeded!==payment.amount_minor){
    return fail(409,"Stripe has not confirmed a full refund. Review the charge in the Stripe Dashboard before trying again.");
  }
}
