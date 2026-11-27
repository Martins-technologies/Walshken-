import assert from "node:assert/strict";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {copyFileSync,mkdirSync,mkdtempSync,readdirSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {GET,POST} from "../app/api/client-documents/[action]/route.ts";
import {workspaceDatabase} from "../lib/walshken/database.ts";
import {createCanvas} from "@napi-rs/canvas";
import {PDFDocument} from "pdf-lib";
import {maintainClientDocuments} from "../lib/walshken/client-documents.ts";
import {documentQualityFlags} from "../lib/walshken/document-render.ts";

assert.equal(process.env.NODE_ENV,"test");
assert.equal(process.env.DATABASE_URL,undefined);
const repo=process.cwd(),sandbox=mkdtempSync(join(tmpdir(),"walshken-client-documents-"));
process.on("exit",()=>rmSync(sandbox,{recursive:true,force:true}));
mkdirSync(join(sandbox,"drizzle"));
for(const name of readdirSync(join(repo,"drizzle")).filter(file=>file.endsWith(".sql")))copyFileSync(join(repo,"drizzle",name),join(sandbox,"drizzle",name));
writeFileSync(join(sandbox,"drizzle","00000_roles.sql"),"CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
const migrations=["20261122145905_staff_document_security.sql","20261122192455_employee_task_workflow.sql","20261125231710_staff_unit_memberships.sql","20261127090000_client_identity.sql","20261127090200_client_cases.sql","20261127090400_client_documents.sql","20261128101000_client_document_intelligence.sql","20261128105000_client_preferences_and_mfa.sql"];
for(const [i,name] of migrations.entries())copyFileSync(join(repo,"supabase","migrations",name),join(sandbox,"drizzle",String(100+i).padStart(4,"0")+"_"+name));
symlinkSync(join(repo,"node_modules"),join(sandbox,"node_modules"),"dir");
symlinkSync(join(repo,"public"),join(sandbox,"public"),"dir");
process.chdir(sandbox);
Object.assign(process.env,{
 WALSHKEN_CLIENT_PORTAL_ENABLED:"1",WALSHKEN_REQUIRE_STAFF_MFA:"0",VERCEL_ENV:"preview",
 WALSHKEN_CLIENT_PREVIEW_DB_OBJECTS:"1",WALSHKEN_CLIENT_MALWARE_SCANNING_REQUIRED:"0",
});
const db=workspaceDatabase();
const query=(sql,...params)=>db.prepare(sql,params);
const site="https://documents.walshken.test",stamp=new Date().toISOString(),future=new Date(Date.now()+86_400_000).toISOString();
const digest=value=>createHash("sha256").update(value).digest("hex");
async function staff(role,name){
  const key=randomUUID(),email=key+"@staff.example.org",token=randomUUID()+randomUUID();
  await query("INSERT INTO employees(id,org_id,employee_no,name,email,role) VALUES(?,'walshken',?,?,?,?)",key,key,name,email,role).run();
  await query("INSERT INTO sessions(id,employee_id,expires_at,agent) VALUES(?,?,?,'QA')",digest(token),key,future).run();
  return {id:key,staff:true,cookie:"walshken_session="+token};
}
async function customer(name,verified=true){
  const key=randomUUID(),email=key+"@client.example.org",token=randomBytes(32).toString("hex");
  await query("INSERT INTO customers(id,name,email,password_hash,email_verified_at) VALUES(?,?,?,'fixture',?)",key,name,email,verified?stamp:null).run();
  await query(`INSERT INTO customer_sessions(id,customer_id,expires_at,session_ref,created_at,last_seen_at,idle_expires_at,reauthenticated_at,device_label,device_digest)
    VALUES(?,?,?,?,?,?,?,?,'QA','fixture')`,digest(token),key,future,randomUUID(),stamp,stamp,future,stamp).run();
  return {id:key,cookie:"walshken_customer="+token,sessionHash:digest(token)};
}

await query("INSERT INTO organizations(id,name,time_zone) VALUES('walshken','Walshken','UTC')").run();
const owner=await customer("Owner"),stranger=await customer("Another client"),unverified=await customer("Unverified",false);
const admin=await staff("super_admin","Document admin"),reviewer=await staff("super_admin","Another administrator");
const assigned=await staff("employee","Assigned representative"),outsider=await staff("employee","Unassigned employee");
const caseId=randomUUID(),otherCase=randomUUID(),requirement=randomUUID();
for(const [sequence,account,key] of [[1,owner,caseId],[2,stranger,otherCase]]){
  await query(`INSERT INTO client_cases(id,org_id,customer_id,reference,title,service,country,assigned_employee_id,representative_name,created_at,updated_at)
    VALUES(?,'walshken',?,?,'Immigration case','Immigration','CA',?,'Representative',?,?)`,key,account.id,"CASE-DOC-"+sequence,assigned.id,stamp,stamp).run();
}
await query(`INSERT INTO client_case_document_requests(id,org_id,case_id,title,instructions,due_on,expected_category,created_by,created_at,updated_at)
 VALUES(?,'walshken',?,'Passport scan','Provide the photo page.',?,'Passport',?,?,?)`,requirement,caseId,future.slice(0,10),admin.id,stamp,stamp).run();
async function request(action,actor,expected=200,options={}){
  const params=new URLSearchParams({case:options.case??caseId});
  if(actor?.staff||options.staff)params.set("scope","staff");
  for(const field of ["document","version","page"])if(options[field])params.set(field,String(options[field]));
  const body=options.body instanceof FormData?options.body:options.body?JSON.stringify({case:options.case??caseId,...options.body}):undefined;
  const incoming=new Request(site+"/api/client-documents/"+action+"?"+params,{method:body?"POST":"GET",headers:{
    Origin:options.origin??site,...(actor?.cookie?{Cookie:actor.cookie}:{}),...(typeof body==="string"?{"Content-Type":"application/json"}:{}),
  },body});
  const res=await (body?POST:GET)(incoming,{params:Promise.resolve({action})});
  if(res.status!==expected)assert.fail(action+" expected "+expected+", received "+res.status+" "+await res.text());
  assert.match(res.headers.get("cache-control"),/no-store/);
  return res;
}
async function data(action,actor,expected,options){return (await request(action,actor,expected,options)).json();}
function form(file,name,info={}){
  const body=new FormData();
  body.set("case",info.case??caseId);body.set("file",new Blob([file]),name);
  body.set("uploadId",info.nonce??randomUUID());
  if(info.document)body.set("document",info.document);
  else{body.set("category",info.category??"Passport");body.set("description","First page");body.set("requirement",info.requirement??requirement);}
  if(info.expiry)body.set("expiry",info.expiry);
  return body;
}
const canvas=createCanvas(640,850),ctx=canvas.getContext("2d");
ctx.fillStyle="#fff";ctx.fillRect(0,0,640,850);ctx.fillStyle="#334a69";ctx.fillRect(70,100,500,40);ctx.fillRect(70,230,450,13);
const png=canvas.toBuffer("image/png");
const pdf=await PDFDocument.create();pdf.addPage();pdf.addPage();const pdfBytes=await pdf.save();
const passportExpiry=new Date(Date.now()+12*86_400_000).toISOString().slice(0,10);
const softScan=createCanvas(700,700),softCtx=softScan.getContext("2d"),gradient=softCtx.createLinearGradient(0,0,700,0);
for(let segment=0;segment<=10;segment++)gradient.addColorStop(segment/10,segment%2?"#ddd":"#333");
softCtx.fillStyle=gradient;softCtx.fillRect(0,0,700,700);
assert.ok((await documentQualityFlags("blur.png",softScan.toBuffer("image/png"))).includes("blur"),"soft image detail flagged for review");

await request("list",null,401);
await request("list",unverified,403);
await request("list",stranger,404);
await request("list",outsider,404);
assert.equal((await data("list",owner,200)).documents.length,0);
assert.equal((await data("list",owner,200)).requests[0].needs_submission,true);
assert.equal((await data("list",owner,200)).watermark,null);
assert.equal((await data("list",admin,200)).watermark.enabled,false);
await request("upload",owner,403,{body:form(png,"valid.png"),origin:"https://untrusted.example"});
await request("upload",assigned,403,{body:form(png,"valid.png")});
await request("upload",owner,404,{body:form(png,"valid.png",{case:otherCase})});
await request("upload",owner,400,{body:form(Buffer.from("not a JPEG"),"bad.jpg")});
await request("upload",owner,413,{body:form(Buffer.alloc(3*1024*1024+1),"big.png")});
await request("upload",owner,400,{body:form(png,"wrong-category.png",{category:"Supporting evidence"})});
process.env.WALSHKEN_CLIENT_MALWARE_SCANNING_REQUIRED="1";
await request("upload",owner,503,{body:form(png,"valid.png")});
process.env.WALSHKEN_CLIENT_MALWARE_SCANNING_REQUIRED="0";
const nonce=randomUUID();
const first=await data("upload",owner,201,{body:form(png,"passport.png",{nonce})});
assert.equal((await data("upload",owner,200,{body:form(png,"passport.png",{nonce})})).id,first.id);
await request("upload",owner,409,{body:form(pdfBytes,"passport.pdf",{nonce})});
let documents=await data("list",owner,200);
assert.equal(documents.documents.length,1);
const document=first.id,old=documents.documents[0].current_version_id;
assert.equal(documents.requests[0].status,"Submitted");
assert.equal(documents.documents[0].scan_status,"Scanning deferred");
assert.equal(documents.documents[0].storage_key,undefined);
const preview=await request("preview",owner,200,{document,version:old});
assert.equal(preview.headers.get("content-type"),"image/jpeg");
assert.equal(preview.headers.get("cross-origin-resource-policy"),"same-origin");
const image=Buffer.from(await preview.arrayBuffer());
assert.deepEqual([...image.subarray(0,2)],[255,216]);
assert.notDeepEqual(image,png);
const watermark={enabled:true,label:"Internal only · QA watermark",opacity:42,position:"bottom",repeat_mark:false,show_client:true,show_time:false,categories:["Passport"],revision:0};
await request("watermark",assigned,403,{body:watermark});
await request("watermark",owner,403,{body:watermark});
await request("watermark-sample",admin,200,{body:watermark});
assert.equal((await data("list",admin,200)).watermark.enabled,false);
await request("watermark",admin,400,{body:{...watermark,opacity:400}});
await request("watermark",admin,200,{body:watermark});
await request("watermark",admin,409,{body:watermark});
const marked=Buffer.from(await (await request("preview",owner,200,{document,version:old})).arrayBuffer());
assert.notDeepEqual(marked,image,"server policy changes rendered preview");
assert.deepEqual(Buffer.from(await (await request("download",admin,200,{document,version:old})).arrayBuffer()),png,"watermark does not alter the downloadable original");
await request("watermark",admin,200,{body:{...watermark,revision:1,enabled:false}});
assert.deepEqual(Buffer.from(await (await request("preview",owner,200,{document,version:old})).arrayBuffer()),image,"default raster restored when admin disables marks");
await request("preview",stranger,404,{document});
await request("preview",outsider,404,{document});
await request("preview",assigned,200,{document});
await request("download",owner,403,{document});
await request("download",assigned,403,{document});
const original=await request("download",admin,200,{document,version:old});
assert.deepEqual(Buffer.from(await original.arrayBuffer()),png);
await request("review",outsider,404,{body:{document,version:old,decision:"Accepted"}});
await request("review",assigned,200,{body:{document,version:old,decision:"Replacement requested",reason:"Include a complete photo page."}});
assert.equal((await data("list",owner,200)).requests[0].status,"Replacement requested");
await request("upload",owner,201,{body:form(pdfBytes,"passport.pdf",{document,expiry:passportExpiry})});
documents=await data("list",owner,200,{document});
assert.deepEqual(documents.history.map(item=>item.version),[2,1]);
assert.equal(documents.history[0].page_count,2);
assert.ok(documents.history[0].quality_flags.includes("blank"));
assert.equal(documents.history[0].submitted_expiry_on,passportExpiry);
const latest=documents.documents[0].current_version_id;
await request("preview",owner,200,{document,version:latest,page:2});
await request("review",assigned,409,{body:{document,version:old,decision:"Accepted"}});
await request("review",assigned,200,{body:{document,version:latest,decision:"Accepted",expiry:passportExpiry}});
assert.equal((await data("list",owner,200)).requests[0].status,"Accepted");
assert.equal((await data("list",owner,200)).documents[0].verified_expiry_on,passportExpiry);
assert.equal((await maintainClientDocuments(db,"walshken")).reminders,1);
assert.equal((await maintainClientDocuments(db,"walshken")).reminders,0);
assert.equal((await data("list",owner,200,{document})).events.length,0);
assert.ok((await data("list",assigned,200,{document})).events.some(event=>event.action==="Replaced"));
const originals=await query("SELECT count(*)::int AS n FROM client_preview_document_objects").first();
assert.equal(originals.n,2);

await request("policy",admin,200,{body:{retention:365,basis:"Reviewed fixture",download:true,revision:0}});
await request("download",owner,200,{document,version:latest});
await query("UPDATE customer_sessions SET reauthenticated_at=? WHERE id=?",new Date(Date.now()-16*60_000).toISOString(),owner.sessionHash).run();
await request("download",owner,403,{document});
const repeated=await data("upload",owner,201,{body:form(png,"passport-addendum.png",{requirement:""})});
assert.ok((await data("list",owner,200)).documents.find(row=>row.id===repeated.id).quality_flags.includes("duplicate"));
await request("hold",admin,200,{body:{document,reason:"Fixture hold reference"}});
await request("request-deletion",owner,200,{body:{document,reason:"Review disposal under the privacy policy"}});
let staffData=await data("list",admin,200,{document});
const disposal=staffData.documents.find(row=>row.id===document).disposal_id;
assert.ok(disposal);
await request("release-hold",admin,403,{body:{document,reason:"Independence check"}});
await request("decide-deletion",reviewer,409,{body:{document,disposal,decision:"Approved",reason:"Held data must stay"}});
await request("release-hold",reviewer,200,{body:{document,reason:"Legal reviewer released the hold"}});
await request("decide-deletion",reviewer,409,{body:{document,disposal,decision:"Approved",reason:"Retention still active"}});
await query("UPDATE client_document_versions SET retain_until=? WHERE document_id=?",new Date(Date.now()-86_400_000).toISOString(),document).run();
await request("decide-deletion",reviewer,200,{body:{document,disposal,decision:"Approved",reason:"Reviewed under fixture policy"}});
assert.equal((await query("SELECT status FROM client_document_disposals WHERE id=?",disposal).first()).status,"Disposed");
await request("preview",owner,404,{document,version:old});
assert.equal((await query("SELECT count(*)::int AS n FROM client_preview_document_objects").first()).n,1);
await query("UPDATE customer_sessions SET ended_at=? WHERE id=?",stamp,owner.sessionHash).run();
await request("list",owner,401);
console.log("PASS client documents: scoped case access, immutable versions, quality and category checks, deduplicated expiry reminders, optional watermark, staff approvals, protected disposal and session revocation");
