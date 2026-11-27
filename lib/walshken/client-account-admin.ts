import {refreshClientCallCaseAccess} from "./client-calls";
import {clientSecurityEvent,endClientSessions} from "./client-sessions";
import {all,audit,fail,id,json,now,one,run,str,type Actor,type Db} from "./server";

type AccessState={suspended_at:string|null;closed_at:string|null;managed:boolean};
async function accessState(db:Db,customerId:string,lock=false){
  return one<AccessState>(db,`SELECT c.suspended_at,
    (SELECT p.created_at FROM client_privacy_requests p WHERE p.customer_id=c.id AND p.type='Account closure' AND p.status='Completed' ORDER BY p.created_at DESC LIMIT 1) AS closed_at,
    COALESCE((SELECT h.action='Suspended' FROM client_account_access_history h WHERE h.customer_id=c.id ORDER BY h.created_at DESC,h.id DESC LIMIT 1),false) AS managed
    FROM customers c WHERE c.id=?${lock?" FOR UPDATE OF c":""}`,customerId);
}
export async function readClientAccess(db:Db,customerId:string){
  const state=await accessState(db,customerId);
  if(!state)return fail(404,"Client account unavailable.");
  const records=await all(db,`SELECT h.id,h.action,h.reason,h.created_at,e.name AS reviewer FROM client_account_access_history h
    JOIN employees e ON e.id=h.employee_id AND e.org_id=h.org_id
    WHERE h.customer_id=? ORDER BY h.created_at DESC,h.id DESC LIMIT 50`,customerId);
  return json({suspended:!!state.suspended_at,canRestore:state.managed&&!state.closed_at,records});
}
export async function changeClientAccess(db:Db,actor:Actor,customerId:string,data:Record<string,unknown>){
  const action=data.action;
  if(action!=="Suspended"&&action!=="Restored")return fail(400,"Choose suspend or restore.");
  const reason=str(data.reason,"access decision reason",1000);
  const cases=await db.transaction(async tx=>{
    const state=await accessState(tx,customerId,true);
    if(!state)return fail(404,"Client account unavailable.");
    if(state.closed_at)return fail(409,"Use the account-closure records workflow for this closed account.");
    if(action==="Suspended"&&state.suspended_at || action==="Restored"&&(!state.managed||!state.suspended_at))return fail(409,"This account access status has changed.");
    const at=now(),target=id();
    await run(tx,"UPDATE customers SET suspended_at=? WHERE id=?",action==="Suspended"?at:null,customerId);
    if(action==="Suspended")await endClientSessions(tx,customerId);
    await run(tx,"INSERT INTO client_account_access_history(id,org_id,customer_id,employee_id,action,reason,created_at) VALUES(?,?,?,?,?,?,?)",target,actor.org_id,customerId,actor.id,action,reason,at);
    await audit(tx,actor,"Client access "+action.toLowerCase(),"client account",customerId).run();
    await clientSecurityEvent(tx,customerId,null,action==="Suspended"?"Company suspended account access":"Company restored account access");
    return action==="Suspended"?all<{id:string}>(tx,"SELECT id FROM client_cases WHERE org_id=? AND customer_id=?",actor.org_id,customerId):[];
  });
  await Promise.allSettled(cases.map(item=>refreshClientCallCaseAccess(db,actor.org_id,item.id)));
  return json({ok:true,message:action==="Suspended"?"Account access suspended and sessions revoked.":"Account access restored."});
}
