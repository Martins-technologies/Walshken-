import {after} from "next/server";
import {
  changeCustomerPassword, changeCustomerProfile, clientActor, clientPortalEnabled, customerFor, customerSignIn,
  customerSignOut, customerSignUp, customerToken, submitCustomerInquiry,
} from "@/lib/walshken/customer";
import {finishClientChallenge,requestClientEmailChange,requestClientPasswordReset,requestClientVerification,resendClientChallenge} from "@/lib/walshken/client-auth";
import {clientSessionStatus,listClientSessions,reauthenticateClient,revokeClientSessions,type Customer} from "@/lib/walshken/client-sessions";
import {changeClientAccess,readClientAccess} from "@/lib/walshken/client-account-admin";
import {clientMfaAction,clientMfaSummary} from "@/lib/walshken/client-mfa";
import {clientLanguages,manageClientLanguages,saveClientLocale} from "@/lib/walshken/client-preferences";
import {withClientDb} from "@/lib/walshken/client-feature";
import {customerProfileData,setVerifiedClientFields} from "@/lib/walshken/client-profile";
import {clientNotifications,notifyClient,processClientNotificationEmails,readClientNotification,setClientNotificationPreferences} from "@/lib/walshken/client-notifications";
import {audit,checkOrigin,currentActor,database,fail,handleError,json,needsStaffMfa,one,payload,requireSuper,str,throttle,type Db} from "@/lib/walshken/server";

export const runtime = "nodejs";

const legacyPosts = ["sign-in","sign-up","sign-out","request","profile","password"];
const clientPosts = [
  ...legacyPosts, "verify","verification","resend","password-reset","password-reset-confirm",
  "activity","email-change","email-change-verify","session-revoke","session-revoke-others","reauthenticate",
  "notification-read","notification-preferences","profile-verification","announcement","mfa-setup","mfa-confirm","mfa-disable","locale","language-policy","account-access",
];
const actionsWithEmail = new Set(["sign-in","verify","password-reset-confirm","password","email-change-verify","announcement","mfa-confirm","mfa-disable"]);

async function profileReviewer(db:Db,request:Request) {
  const actor = await currentActor(db,request);
  if (!actor || needsStaffMfa(actor)) return fail(401,"Use your authorized staff account.");
  requireSuper(actor);
  return actor;
}

export async function GET(request:Request,{params}:{params:Promise<{action:string}>}) {
  try {
    const {action} = await params;
    if (!clientPortalEnabled() || !["status","profile","sessions","notifications","profile-verification","mfa","locale","language-policy","account-access"].includes(action)) {
      return fail(404,"Client account action unavailable.");
    }
    const db=database();
    if(action==="status")return await clientSessionStatus(db,request);
    if(action==="account-access"){await profileReviewer(db,request);return readClientAccess(db,str(new URL(request.url).searchParams.get("id"),"client",80));}
    if(action==="language-policy"){await profileReviewer(db,request);return json(await clientLanguages(db));}
    if(action==="profile-verification"){
      const reviewer=await profileReviewer(db,request);
      const clientId=str(new URL(request.url).searchParams.get("id"),"client",80);
      const client=await one<Customer>(db,"SELECT id,name,email FROM customers WHERE id=? AND email_verified_at IS NOT NULL AND suspended_at IS NULL",clientId);
      if(!client)return fail(404,"Client profile unavailable.");
      await audit(db,reviewer,"Client profile opened for verification","client profile",client.id).run();
      return await customerProfileData(db,client);
    }
    const actor=await clientActor(db,request);
    return await withClientDb(db,actor.id,tx=>{
      if(action==="profile")return customerProfileData(tx,actor);
      if(action==="sessions")return listClientSessions(tx,actor);
      if(action==="mfa")return clientMfaSummary(tx,actor.id);
      if(action==="locale")return clientLanguages(tx,actor.id).then(result=>json(result));
      return clientNotifications(tx,actor.id);
    });
  }catch(error){return handleError(error);}
}

async function postClient(request:Request,db:Db,action:string,data:Record<string,unknown>) {
  if(action==="verify"||action==="password-reset-confirm"||action==="email-change-verify")return finishClientChallenge(db,request,action,data);
  if(action==="account-access")return changeClientAccess(db,await profileReviewer(db,request),str(data.id,"client",80),data);
  if(action==="language-policy")return manageClientLanguages(db,await profileReviewer(db,request),data.enabled);
  if(action==="verification")return requestClientVerification(db,request);
  if(action==="resend")return resendClientChallenge(db,request,data);
  if(action==="password-reset")return requestClientPasswordReset(db,request,data);
  if(action==="email-change")return requestClientEmailChange(db,request,data);
  if(action==="activity")return clientSessionStatus(db,request,true);
  if(action==="profile-verification"){
    const reviewer=await profileReviewer(db,request),target=str(data.id,"client",80);
    return setVerifiedClientFields(db,reviewer,target,data);
  }
  if(action==="announcement"){
    const reviewer=await profileReviewer(db,request),target=str(data.id,"client",80),caseId=str(data.case,"case",80,false);
    const title=str(data.title,"announcement title",150),body=str(data.body,"announcement text",600),reference=str(data.reference,"send reference",80);
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(reference))return fail(400,"Refresh this announcement before publishing.");
    await throttle(db,`client-announcement:${reviewer.id}`,30,300_000);
    return db.transaction(async tx=>{
      if(!await one(tx,"SELECT id FROM customers WHERE id=? AND email_verified_at IS NOT NULL AND suspended_at IS NULL FOR UPDATE",target))
        return fail(404,"Verified client unavailable.");
      if(caseId&&!await one(tx,"SELECT id FROM client_cases WHERE org_id=? AND id=? AND customer_id=?",reviewer.org_id,caseId,target))
        return fail(404,"This case is unavailable for the selected client.");
      const href=caseId?`/customer/cases?case=${encodeURIComponent(caseId)}`:"/customer/notifications",dedupeKey=`announcement:${reference}`;
      const item=await notifyClient(tx,target,{type:"announcement",title,body,href,dedupeKey});
      if(!item){
        const previous=await one<{title:string;body:string;href:string}>(tx,"SELECT title,body,href FROM client_notifications WHERE customer_id=? AND dedupe_key=?",target,dedupeKey);
        if(!previous||previous.title!==title||previous.body!==body||previous.href!==href)return fail(409,"This send reference has already been used. Refresh before publishing.");
      } else await audit(tx,reviewer,"Client announcement published","client notification",item).run();
      return json({ok:true,message:"Announcement published to the selected client’s notification center."},item?201:200);
    });
  }
  const actor=await clientActor(db,request,{touch:true});
  if(action.startsWith("mfa-"))return withClientDb(db,actor.id,tx=>clientMfaAction(request,tx,actor,action,data));
  if(action==="locale")return withClientDb(db,actor.id,tx=>saveClientLocale(tx,actor.id,data.locale));
  if(action==="session-revoke"||action==="session-revoke-others")return revokeClientSessions(db,request,actor,action==="session-revoke"?str(data.id,"session",80):undefined);
  if(action==="reauthenticate")return reauthenticateClient(db,request,actor,data);
  if(action==="notification-read")return readClientNotification(db,actor.id,data);
  if(action==="notification-preferences")return setClientNotificationPreferences(db,actor.id,data);
  if(action==="request")return submitCustomerInquiry(request,db,actor,data);
  if(action==="profile")return changeCustomerProfile(db,actor,data);
  if(action==="password")return changeCustomerPassword(request,db,actor,customerToken(request.headers.get("cookie")),data);
  return fail(404,"Client account action unavailable.");
}

export async function POST(request:Request,{params}:{params:Promise<{action:string}>}) {
  try {
    checkOrigin(request);
    const {action}=await params,enabled=clientPortalEnabled();
    if (!(enabled?clientPosts:legacyPosts).includes(action)) return fail(404,"Client account action unavailable.");
    const db=database(),token=customerToken(request.headers.get("cookie"));
    if(action==="sign-out")return await customerSignOut(request,db,token);
    const data=await payload(request);
    let response:Response;
    if(action==="sign-up")response=await customerSignUp(request,db,data);
    else if(action==="sign-in")response=await customerSignIn(request,db,data);
    else if(enabled)response=await postClient(request,db,action,data);
    else {
      const actor=await customerFor(db,token);
      if(!actor)return fail(401,"Sign in to your customer account.");
      if(action==="request")return await submitCustomerInquiry(request,db,actor,data);
      if(action==="profile")return await changeCustomerProfile(db,actor,data);
      return await changeCustomerPassword(request,db,actor,token,data);
    }
    if(enabled&&response.ok&&actionsWithEmail.has(action)&&process.env.NODE_ENV!=="test"){
      after(async()=>{try{await processClientNotificationEmails(db);}catch{console.error("Client security email is queued for retry.");}});
    }
    return response;
  }catch(error){return handleError(error);}
}
