import {clientLocales,isClientLocale} from "./client-locales";
import {audit,fail,json,now,one,orgId,run,type Actor,type Db} from "./server";

type Languages={enabled:string[]};
const policy=(db:Db,organization=orgId)=>one<Languages>(db,"SELECT enabled FROM client_portal_language_policy WHERE org_id=?",organization);

export async function clientLanguages(db:Db,customerId?:string){
  const [rule, saved]=await Promise.all([policy(db),customerId
    ?one<{locale:string}>(db,"SELECT locale FROM client_portal_preferences WHERE customer_id=?",customerId)
    :Promise.resolve(null)]);
  const enabled=(rule?.enabled??[...clientLocales]).filter(isClientLocale);
  const requested=saved?.locale;
  return {enabled,locale:isClientLocale(requested)&&enabled.includes(requested)?requested:"en" as const};
}
export async function saveClientLocale(db:Db,customerId:string,input:unknown){
  if(!isClientLocale(input))return fail(400,"Choose a supported portal language.");
  const {enabled}=await clientLanguages(db,customerId);
  if(!enabled.includes(input))return fail(409,"This language is currently disabled.");
  await run(db,`INSERT INTO client_portal_preferences(customer_id,locale,updated_at) VALUES(?,?,?)
    ON CONFLICT(customer_id) DO UPDATE SET locale=excluded.locale,updated_at=excluded.updated_at`,customerId,input,now());
  return json({ok:true,locale:input,enabled});
}
export async function manageClientLanguages(db:Db,actor:Actor,input:unknown){
  if(!Array.isArray(input)||input.some(value=>!isClientLocale(value)))return fail(400,"Select valid portal languages.");
  const enabled=clientLocales.filter(locale=>locale==="en"||input.includes(locale));
  await db.transaction(async tx=>{
    await run(tx,`INSERT INTO client_portal_language_policy(org_id,enabled,updated_at) VALUES(?,?::text[],?)
      ON CONFLICT(org_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at`,actor.org_id,enabled,now());
    await audit(tx,actor,"Client portal languages changed","client portal",actor.org_id).run();
  });
  return json({ok:true,enabled});
}
