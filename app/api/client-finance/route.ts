import {clientActor} from "@/lib/walshken/client-sessions";
import {clientPortalEnabled,withClientDb} from "@/lib/walshken/client-feature";
import {clientAgreementAction,clientFinanceSummary,financeDownload,financeView} from "@/lib/walshken/client-finance";
import {createCheckout} from "@/lib/walshken/client-finance-payments";
import {checkOrigin,database,fail,handleError,json,orgId,payload,pick,str,throttle} from "@/lib/walshken/server";

export const runtime="nodejs";

function requireFinance() {
  if(!clientPortalEnabled())return fail(404,"Client finance is unavailable.");
}

export async function GET(request:Request) {
  try{
    requireFinance();
    const db=database(),actor=await clientActor(db,request);
    const params=new URL(request.url).searchParams,scope={orgId,customerId:actor.id};
    return await withClientDb(db,actor.id,async tx=>{
      if(params.has("kind")){
        await throttle(tx,"client-finance-download:"+actor.id,40,60_000);
        return financeDownload(tx,scope,params);
      }
      await throttle(tx,"client-finance-view:"+actor.id,75,60_000);
      if(params.get("summary")==="1")return json(await clientFinanceSummary(tx,{...scope,caseId:str(params.get("caseId"),"case",80,false)}));
      return json(await financeView(tx,scope));
    });
  }catch(error){return handleError(error);}
}

export async function POST(request:Request) {
  try{
    requireFinance();
    checkOrigin(request);
    const data=await payload(request),action=pick(data.action,["checkout","agreement-sign","agreement-decline"],"finance action");
    const db=database(),actor=await clientActor(db,request,{touch:true,recent:action!=="checkout"});
    await throttle(db,"client-finance-action:"+actor.id,18,60_000);
    if(action==="checkout")return json(await createCheckout(db,request,actor.id,str(data.id,"invoice",80),{amountMinor:data.amountMinor,payNext:data.payNext}));
    return json(await withClientDb(db,actor.id,tx=>clientAgreementAction(tx,actor,{orgId,customerId:actor.id},data)));
  }catch(error){return handleError(error);}
}
