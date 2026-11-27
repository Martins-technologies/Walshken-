import {all,decryptSettings,fail,one,type Db,type Row} from './server';

const serverProviders=new Set(['livekit','recording-storage','document-storage-review','client-document-storage']);
function serverSettings():Record<string,Record<string,string>>{
 const raw=process.env.WALSHKEN_SERVER_INTEGRATIONS;
 if(!raw)return {};
 let values:unknown;try{values=JSON.parse(raw);}catch{return fail(503,'Server integration configuration is invalid.');}
 if(!values||typeof values!=='object'||Array.isArray(values))return fail(503,'Server integration configuration is invalid.');
 const result:Record<string,Record<string,string>>={};
 for(const [key,value] of Object.entries(values)){
  if(!serverProviders.has(key)||!value||typeof value!=='object'||Array.isArray(value)||Object.values(value).some(v=>typeof v!=='string'))return fail(503,'Server integration configuration is invalid.');
  result[key]=value as Record<string,string>;
 }
 return result;
}
export async function integrationSettings(db:Db,key:string,requireEnabled=true){
 const saved=await one<{configuration:string;enabled:number}>(db,'SELECT configuration,enabled FROM integrations WHERE id=?',key);
 if(saved){
  if(requireEnabled&&!saved.enabled)return null;
  return decryptSettings(key,saved.configuration);
 }
 return serverSettings()[key]??null;
}
export async function integrationStatuses(db:Db,org:string){
 const rows=await all<Row>(db,`SELECT i.id,i.enabled,i.updated_at,t.action AS last_test,t.created_at AS tested_at FROM integrations i
  LEFT JOIN LATERAL (SELECT action,created_at FROM audit WHERE org_id=? AND entity='integration' AND target_id=i.id
   AND action IN ('Integration connection test succeeded','Integration connection test failed') ORDER BY created_at DESC,id DESC LIMIT 1) t ON true ORDER BY i.id`,org);
 for(const key of Object.keys(serverSettings()))if(!rows.some(row=>row.id===key)){
  const test=await one<Row>(db,`SELECT action AS last_test,created_at AS tested_at FROM audit
   WHERE org_id=? AND entity='integration' AND target_id=?
   AND action IN ('Integration connection test succeeded','Integration connection test failed') ORDER BY created_at DESC,id DESC LIMIT 1`,org,key);
  rows.push({id:key,enabled:1,source:'server',...test});
 }
 return rows;
}
