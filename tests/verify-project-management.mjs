import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

export async function verifyProjectManagement({ db, request, admin, staff, hr, person, adminId, staffId, runId }) {
  process.env.WALSHKEN_TASK_DATASET="preview";
  const manager=await person("employee","Assigned project manager","PROJECT-MANAGER-"+runId);
  const teamMember=await person("employee","Project team member","PROJECT-TEAM-"+runId);
  const outsider=await person("employee","Outside project","PROJECT-OUTSIDE-"+runId);
  const proof="Project assignment implementation "+runId;
  const team="project-team-"+runId,otherDepartment="project-elsewhere-"+runId;
  const department=(await db.prepare("SELECT department_id FROM employees WHERE id=?",[staffId]).first()).department_id;
  for(const [id,kind,name] of [[team,"Team","Project team"],[otherDepartment,"Department","Outside team"]]){
    await db.prepare("INSERT INTO units(id,org_id,kind,name) VALUES(?,'walshken',?,?)",[id,kind,name]).run();
  }
  await db.prepare("UPDATE employees SET department_id=? WHERE id IN (?,?)",[otherDepartment,teamMember.id,outsider.id]).run();
  await db.prepare("INSERT INTO staff_unit_memberships(org_id,employee_id,unit_id,created_by,created_at) VALUES('walshken',?,?,?,?)",
    [teamMember.id,team,adminId,new Date().toISOString()]).run();
  const project=(await request("projects/add",201,admin,{name:proof,description:"Private project work",owner:adminId,manager:manager.id,department,team,
    priority:"High",start:"2027-05-01",due:"2027-05-20",employees:[staffId]})).id;
  const detail=user=>request("view/projects?project="+project,200,user);
  const found=async user=>(await detail(user)).rows.find(row=>row.id===project);
  assert.equal((await found(staff)).team_id,team);
  assert.equal((await found(staff)).priority,"High");
  assert.equal((await found(staff)).can_manage,0);
  assert.equal((await found(manager)).can_manage,1);
  assert.equal((await found(manager)).can_administer,0);
  assert.equal(await found(hr),undefined);
  assert.equal(await found(outsider),undefined);
  assert.equal(await found(teamMember),undefined,"Team membership alone must not grant project access");
  await request("projects/assign",404,outsider,{id:project,revision:1,employees:[outsider.id]});
  await request("projects/assign",403,staff,{id:project,revision:1,employees:[staffId,outsider.id]});
  await request("projects/assign",403,manager,{id:project,revision:1,employees:[staffId,outsider.id]});
  await request("projects/edit",403,manager,{id:project,revision:1,name:proof,owner:manager.id});
  await request("projects/assign",200,manager,{id:project,revision:1,employees:[staffId,teamMember.id]});
  await request("projects/assign",200,manager,{id:project,revision:2,employees:[staffId,teamMember.id]});
  assert.equal((await detail(teamMember)).assignments.length,2);
  await request("projects/milestone-add",200,manager,{id:project,revision:2,title:"Verify evidence",due:"2027-05-19",assignee:teamMember.id});
  const milestone=(await detail(teamMember)).milestones[0];
  await request("projects/milestone-complete",403,staff,{id:project,revision:3,milestone:milestone.id});
  const { maintainProjects }=await import("../lib/walshken/project-work.ts");
  assert.ok(await maintainProjects(db,"2027-05-18T15:00:00.000Z")>=5);
  assert.equal(await maintainProjects(db,"2027-05-18T15:00:00.000Z"),0);
  const notices=(await db.prepare("SELECT title FROM notifications WHERE employee_id=? AND href=?",[teamMember.id,"/staff/projects?project="+project]).all()).results;
  assert.ok(notices.some(row=>row.title==="Upcoming project deadline"));
  assert.ok(notices.some(row=>row.title==="Project assigned"));
  await request("projects/milestone-complete",200,teamMember,{id:project,revision:3,milestone:milestone.id});
  assert.ok(await maintainProjects(db,"2027-05-22T15:00:00.000Z")>=4);
  const overdue=await db.prepare("SELECT id FROM notifications WHERE employee_id=? AND href=? AND title='Project work overdue'",
    [teamMember.id,"/staff/projects?project="+project]).first();
  assert.ok(overdue);
  const after=await detail(teamMember);
  assert.equal(after.milestones[0].completed_by,teamMember.id);
  assert.equal(after.workload[0].milestones_done,1);
  await request("projects/assign",200,manager,{id:project,revision:4,employees:[teamMember.id]});
  assert.equal(await found(staff),undefined);
  const retained=(await detail(admin)).assignments.find(row=>row.employee_id===staffId);
  assert.ok(retained.assigned_at&&retained.unassigned_at&&retained.unassigned_by===manager.id);
  await assert.rejects(()=>db.prepare("DELETE FROM project_assignments WHERE id=?",[retained.id]).run(),/immutable/);
  await assert.rejects(()=>db.prepare("UPDATE project_assignments SET unassigned_at=NULL WHERE id=?",[retained.id]).run(),/immutable/);
  const deliverable=(await request("projects/deliverable-add",201,manager,{id:project,revision:5,title:"Evidence file",description:"Submit approved work",due:"2027-05-19",assignee:teamMember.id})).id;
  await request("projects/submit",409,manager,{id:project,revision:6});
  await testDelivery({db,admin,manager,teamMember,outsider,project,deliverable,request});
  await request("projects/submit",200,manager,{id:project,revision:8});
  await request("projects/review",404,hr,{id:project,revision:9,decision:"Approve",reason:"No authority"});
  await request("governance/permission-save",200,admin,{principalType:"employee",principal:hr.id,scopeType:"employee",
    scopeId:adminId,capability:"projects.review",effect:"allow"});
  await request("projects/review",403,manager,{id:project,revision:9,decision:"Approve",reason:"Manager cannot self-approve"});
  await request("projects/review",200,hr,{id:project,revision:9,decision:"Approve",reason:"Independently reviewed delivered evidence"});
  assert.equal((await found(admin)).status,"Completed");
  assert.ok((await detail(admin)).events.some(row=>row.action.startsWith("Project approved")));
  console.log("PASS individual and multiple assignments, project-manager scope, HR delegation, immediate reassignment revocation, immutable history, milestone/workload attribution, reminders and project approval");
}

async function testDelivery({db,manager,teamMember,outsider,project,deliverable,request}){
  const {encryptSettings}=await import("../lib/walshken/server.ts");
  const { GET, POST }=await import("../app/api/projects/deliverable/route.ts");
  const {createCanvas}=await import("@napi-rs/canvas");
  const png=createCanvas(24,24).toBuffer("image/png");
  const env=["WALSHKEN_DOCUMENT_STORAGE_ID","WALSHKEN_TASK_BUCKET","WALSHKEN_MALWARE_SCANNING_REQUIRED"];
  const original=Object.fromEntries(env.map(key=>[key,process.env[key]])),network=globalThis.fetch,objects=new Map();
  process.env.WALSHKEN_DOCUMENT_STORAGE_ID="project-document-test";
  process.env.WALSHKEN_TASK_BUCKET="walshken-task-files-review";
  process.env.WALSHKEN_MALWARE_SCANNING_REQUIRED="0";
  const settings={endpoint:"https://ssggjxyexwkshtcypsaq.storage.supabase.co/storage/v1/s3",region:"us-west-2",bucket:"walshken-documents-review",
    accessKey:"fixture",secretKey:randomBytes(20).toString("hex")};
  await db.prepare("INSERT INTO integrations(id,configuration,enabled,updated_at) VALUES(?,?,1,?)",
    [process.env.WALSHKEN_DOCUMENT_STORAGE_ID,await encryptSettings(process.env.WALSHKEN_DOCUMENT_STORAGE_ID,settings),new Date().toISOString()]).run();
  globalThis.fetch=async (input,options)=>{
    const req=input instanceof Request?input:new Request(input,options),url=new URL(req.url);
    assert.equal(url.hostname,"ssggjxyexwkshtcypsaq.storage.supabase.co");
    assert.match(url.pathname,/\/walshken-task-files-review\/walshken\/walshken\/project-deliverables\/preview\//);
    if(req.method==="PUT"){objects.set(url.pathname,Buffer.from(await req.arrayBuffer()));return new Response(null,{status:200});}
    if(req.method==="DELETE"){objects.delete(url.pathname);return new Response(null,{status:204});}
    if(req.method==="GET"){const file=objects.get(url.pathname);return file?new Response(file,{headers:{"Content-Type":"image/png","Content-Length":String(file.length)}}):new Response(null,{status:404});}
    throw Error("Unexpected file operation "+req.method);
  };
  const endpoint="https://test.walshken.test/api/projects/deliverable";
  const send=async(method,user,body,query)=>{
    const headers={origin:"https://test.walshken.test",...(user?{cookie:user.cookie}:{})};
    return (method==="GET"?GET:POST)(new Request(endpoint+(query??""),{method,headers,body}));
  };
  const upload=()=>{const data=new FormData();data.set("project",project);data.set("deliverable",deliverable);data.set("revision","6");
    data.set("file",new File([png],"evidence.png"));return data;};
  try{
    assert.equal((await send("POST",outsider,upload())).status,404);
    const submitted=await send("POST",teamMember,upload());
    const submission=await submitted.json();
    assert.equal(submitted.status,201,submission.error);
    const query="?"+new URLSearchParams({project,deliverable,version:submission.id});
    assert.equal((await send("GET",null,undefined,query)).status,401);
    assert.equal((await send("GET",outsider,undefined,query)).status,404);
    const download=await send("GET",manager,undefined,query);
    assert.equal(download.status,200);
    assert.equal(download.headers.get("cache-control"),"private, no-store");
    assert.deepEqual(Buffer.from(await download.arrayBuffer()),png);
    await request("projects/deliverable-review",200,manager,{id:project,revision:7,deliverable,version:submission.id,decision:"Approved",reason:"Evidence approved"});
    console.log("PASS private project upload, storage integrity, unauthorized download denial and independent deliverable review");
  }finally{
    globalThis.fetch=network;
    for(const key of env){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}
  }
}
