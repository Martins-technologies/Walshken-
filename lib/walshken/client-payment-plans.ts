import {notifyClient} from "./client-notifications";
import {all,date,fail,id,integer,now,one,pick,run,type Db} from "./server";
import {financeActivity,type CaseFinance,type Invoice} from "./client-finance-records";

type Plan={id:string;invoice_id:string;mode:"Partial"|"Installments"};
type Installment={id:string;plan_id:string;position:number;due_on:string;amount_minor:number};
type ScheduleItem=Omit<Installment,"plan_id">&{paid_minor:number;balance_minor:number};

export async function clientPaymentSchedules(db:Db,invoices:string[],paidByInvoice:Map<string,number>) {
  if(!invoices.length)return new Map<string,{mode:Plan["mode"];installments:ScheduleItem[]}>();
  const plans=await all<Plan>(db,"SELECT id,invoice_id,mode FROM client_payment_plans WHERE invoice_id=ANY(?::text[]) AND retired_at IS NULL",invoices);
  if(!plans.length)return new Map<string,{mode:Plan["mode"];installments:ScheduleItem[]}>();
  const rows=await all<Installment>(db,`SELECT id,plan_id,position,due_on,amount_minor FROM client_payment_installments
    WHERE plan_id=ANY(?::text[]) ORDER BY position`,plans.map(plan=>plan.id));
  return new Map(plans.map(plan=>{
    let remaining=paidByInvoice.get(plan.invoice_id)??0;
    const installments=rows.filter(row=>row.plan_id===plan.id).map(({plan_id:_,...item})=>{
      const paid=Math.min(remaining,item.amount_minor);
      remaining-=paid;
      return {...item,paid_minor:paid,balance_minor:item.amount_minor-paid};
    });
    return [plan.invoice_id,{mode:plan.mode,installments}];
  }));
}

export async function paidOnInvoice(db:Db,invoice:Pick<Invoice,"org_id"|"id">) {
  return await one<{amount:number;count:number}>(db,`SELECT COALESCE(SUM(amount_minor),0)::int AS amount,COUNT(*)::int AS count
    FROM client_payments WHERE org_id=? AND invoice_id=? AND status='Paid'`,invoice.org_id,invoice.id)??{amount:0,count:0};
}

export async function setClientPaymentPlan(db:Db,invoice:Invoice,actorId:string,data:Record<string,unknown>) {
  if(invoice.status!=="Open"||await one(db,`SELECT id FROM client_payments WHERE invoice_id=? AND status NOT IN ('Failed','Expired','Refunded') LIMIT 1`,invoice.id)){
    return fail(409,"Change a payment plan before payment has started and while there is no active checkout.");
  }
  const mode=pick(data.mode,["Full","Partial","Installments"] as const,"payment plan"),at=now();
  let items:{dueOn:string;amount:number}[]=[];
  if(mode==="Installments"){
    if(!Array.isArray(data.installments)||data.installments.length<2||data.installments.length>24)return fail(400,"Enter between 2 and 24 installments.");
    items=data.installments.map(raw=>{
      if(!raw||typeof raw!=="object"||Array.isArray(raw))return fail(400,"Enter valid installments.");
      return {dueOn:date(raw.dueOn,"installment due date")!,amount:integer(raw.amountMinor,"installment amount",1,invoice.total_minor)};
    });
    if(items.some((item,index)=>item.dueOn<at.slice(0,10)||(index>0&&item.dueOn<=items[index-1].dueOn))){
      return fail(400,"Use a different date for each installment, starting today or later and in chronological order.");
    }
    if(items.reduce((sum,item)=>sum+item.amount,0)!==invoice.total_minor)return fail(400,"Installment amounts must add up to the total invoice amount.");
  }
  const retired=await run(db,"UPDATE client_payment_plans SET retired_at=? WHERE invoice_id=? AND retired_at IS NULL",at,invoice.id);
  if(mode==="Full"&&!retired.count)return {id:invoice.id,message:"This invoice already requires full payment."};
  const plan=id();
  if(mode!=="Full"){
    await run(db,`INSERT INTO client_payment_plans(id,org_id,invoice_id,customer_id,mode,created_by,created_at)
      VALUES (?,?,?,?,?,?,?)`,plan,invoice.org_id,invoice.id,invoice.customer_id,mode,actorId,at);
    for(const [index,item] of items.entries()){
      await run(db,`INSERT INTO client_payment_installments(id,plan_id,org_id,invoice_id,customer_id,position,due_on,amount_minor)
        VALUES (?,?,?,?,?,?,?,?)`,id(),plan,invoice.org_id,invoice.id,invoice.customer_id,index+1,item.dueOn,item.amount);
    }
  }
  const caseRecord:CaseFinance={id:invoice.case_id,org_id:invoice.org_id,customer_id:invoice.customer_id,reference:invoice.case_reference};
  const action=mode==="Full"?"Payment plan retired":"Payment plan published";
  await financeActivity(db,caseRecord,actorId,action,invoice.id,mode==="Installments"
    ? invoice.invoice_number+" has "+items.length+" installments."
    : `${invoice.invoice_number} now accepts ${mode==="Full"?"full payment only":"partial payments"}.`);
  await notifyClient(db,invoice.customer_id,{type:"payment",title:"Payment options updated",
    body:"Check the payment options for "+invoice.invoice_number+" in Payments & Invoices.",
    href:"/customer/payments",dedupeKey:"payment-plan:"+plan});
  return {id:invoice.id,message:"Payment options saved."};
}

export async function remindClientPayments(db:Db) {
  const horizon=new Date(Date.now()+3*86_400_000).toISOString().slice(0,10);
  const newest=new Date(Date.now()-3*86_400_000).toISOString().slice(0,10);
  const reminders=await all<{reference:string;customer_id:string;due_on:string;dedupe:string}>(db,`
    WITH invoice_balances AS (
      SELECT i.id,i.invoice_number,i.customer_id,i.due_on,i.total_minor,
        COALESCE((SELECT SUM(p.amount_minor) FROM client_payments p WHERE p.invoice_id=i.id AND p.org_id=i.org_id AND p.status='Paid'),0) AS paid
      FROM client_invoices i JOIN customers c ON c.id=i.customer_id
      WHERE i.status='Open' AND c.email_verified_at IS NOT NULL AND c.suspended_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM client_payments q WHERE q.invoice_id=i.id AND q.status IN ('Creating','Pending','Processing','Review'))
    ), schedules AS (
      SELECT b.invoice_number AS reference,b.customer_id,s.due_on,s.id AS target,
        SUM(s.amount_minor) OVER(PARTITION BY s.plan_id ORDER BY s.position) AS cumulative,b.paid
      FROM invoice_balances b JOIN client_payment_plans p ON p.invoice_id=b.id AND p.retired_at IS NULL
      JOIN client_payment_installments s ON s.plan_id=p.id
      UNION ALL
      SELECT b.invoice_number,b.customer_id,b.due_on,b.id,b.total_minor,b.paid
      FROM invoice_balances b WHERE NOT EXISTS(SELECT 1 FROM client_payment_plans p
        WHERE p.invoice_id=b.id AND p.retired_at IS NULL AND p.mode='Installments')
    )
    SELECT reference,customer_id,due_on,'payment-due:'||target||':'||due_on AS dedupe FROM schedules
    WHERE paid<cumulative AND due_on BETWEEN ? AND ?
      AND NOT EXISTS(SELECT 1 FROM client_notifications n WHERE n.customer_id=schedules.customer_id
        AND n.dedupe_key='payment-due:'||schedules.target||':'||schedules.due_on)
    ORDER BY due_on,target LIMIT 100`,newest,horizon);
  let queued=0;
  for(const reminder of reminders){
    const notification=await notifyClient(db,reminder.customer_id,{type:"payment-reminder",title:"Payment reminder",
      body:`${reminder.reference} has a payment due ${reminder.due_on}. Check the balance in the portal.`,
      href:"/customer/payments",dedupeKey:reminder.dedupe});
    if(notification)queued++;
  }
  return {scanned:reminders.length,queued};
}
