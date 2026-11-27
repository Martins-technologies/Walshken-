import {requireClientCases} from "@/lib/walshken/client-cases";
import {withClientDb} from "@/lib/walshken/client-feature";
import {clientJourneyView, familyPrivateDetails, mutateClientJourney, staffJourneyView} from "@/lib/walshken/client-journey";
import {clientActor} from "@/lib/walshken/customer";
import {checkOrigin,currentActor,database,fail,handleError,json,needsStaffMfa,payload,requireStaff,str,throttle,type Db} from "@/lib/walshken/server";

export const runtime="nodejs";

async function staff(db:Db,request:Request){
  const actor=await currentActor(db,request);
  if(!actor)return fail(401,"Sign in to your staff account.");
  if(needsStaffMfa(actor))return fail(403,"Complete two-factor authentication to access client cases.");
  requireStaff(actor);
  return actor;
}

export async function GET(request:Request){
  try{
    requireClientCases();
    const db=database(),params=new URL(request.url).searchParams;
    const caseId=str(params.get("case"),"case",80,false),target=str(params.get("dependant"),"family member",80,false);
    if(params.get("audience")==="staff"){
      const actor=await staff(db,request);
      if(!caseId)return fail(400,"Choose a case first.");
      if(target){
        await throttle(db,"staff-client-family:"+actor.id,25,60_000);
        return json(await familyPrivateDetails(db,{kind:"staff",actor},caseId,target));
      }
      return json(await staffJourneyView(db,actor,caseId));
    }
    const actor=await clientActor(db,request,{touch:false,recent:Boolean(target)});
    if(target)await throttle(db,"client-family-private:"+actor.id,25,60_000);
    return await withClientDb(db,actor.id,async tx=>json(target
      ?await familyPrivateDetails(tx,{kind:"client",actor},caseId,target)
      :await clientJourneyView(tx,actor,caseId,params.get("overview")==="1")));
  }catch(error){return handleError(error);}
}

export async function POST(request:Request){
  try{
    checkOrigin(request);requireClientCases();
    const db=database(),input=await payload(request),action=str(input.action,"journey action",40);
    if(new URL(request.url).searchParams.get("audience")==="staff"){
      const actor=await staff(db,request);
      await throttle(db,"staff-client-journey:"+actor.id,45,60_000);
      return json(await mutateClientJourney(db,{kind:"staff",actor},action,input));
    }
    const actor=await clientActor(db,request,{touch:true,recent:action.startsWith("family-")});
    await throttle(db,"client-journey:"+actor.id,45,60_000);
    return await withClientDb(db,actor.id,async tx=>json(await mutateClientJourney(tx,{kind:"client",actor},action,input)));
  }catch(error){return handleError(error);}
}
