import { clientActor } from "@/lib/walshken/customer";
import { withClientDb } from "@/lib/walshken/client-feature";
import { clientCaseView, customerCaseAction, requireClientCases } from "@/lib/walshken/client-cases";
import { clientPrivacyExport, clientPrivacyView, customerPrivacyAction } from "@/lib/walshken/client-case-privacy";
import { checkOrigin, database, handleError, json, payload, str } from "@/lib/walshken/server";

export const runtime="nodejs";
export async function GET(request:Request) {
  try {
    requireClientCases();
    const db=database(),params=new URL(request.url).searchParams;
    const target=str(params.get("case"),"case",80,false),exportId=str(params.get("export"),"export request",80,false);
    const actor=await clientActor(db,request,{touch:false,recent:Boolean(exportId)});
    return await withClientDb(db,actor.id,async tx=>{
      if(exportId)return clientPrivacyExport(tx,actor.id,exportId);
      const cases=await clientCaseView(tx,actor.id,target);
      return json({...cases,...await clientPrivacyView(tx,actor.id,target)});
    });
  }catch(error){return handleError(error);}
}
export async function POST(request:Request) {
  try {
    checkOrigin(request);requireClientCases();
    const db=database(),data=await payload(request);
    const action=str(data.action,"client action",40);
    const actor=await clientActor(db,request,{touch:true,recent:action==="privacy-request"&&data.type==="Account closure"});
    return await withClientDb(db,actor.id,tx=>action==="privacy-request"||action==="consent"
      ? customerPrivacyAction(tx,actor.id,action,data)
      : customerCaseAction(tx,actor,action,data));
  }catch(error){return handleError(error);}
}
