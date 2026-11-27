import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET, POST } from "../app/api/staff-performance/route.ts";
import { workspaceDatabase } from "../lib/walshken/database.ts";

assert.equal(process.env.NODE_ENV,"test");
assert.equal(process.env.DATABASE_URL,undefined,"Performance fixtures must never connect to a hosted database");
const repo=process.cwd(), sandbox=mkdtempSync(join(tmpdir(),"walshken-performance-"));
process.on("exit",()=>rmSync(sandbox,{recursive:true,force:true}));
mkdirSync(join(sandbox,"drizzle"));mkdirSync(join(sandbox,"public"));
for(const file of readdirSync(join(repo,"drizzle")).filter(file=>file.endsWith(".sql")))copyFileSync(join(repo,"drizzle",file),join(sandbox,"drizzle",file));
writeFileSync(join(sandbox,"drizzle","00000_roles.sql"),"CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE walshken_production_app;");
const dependencies = [
 "20261122145905_staff_document_security.sql",
 "20261122192455_employee_task_workflow.sql",
 "20261122203136_employee_attendance_shifts_timesheets.sql",
 "20261124192707_staff_readiness.sql",
 "20261125093948_project_lifecycle_and_workforce_reporting.sql",
 "20261125231710_staff_unit_memberships.sql",
 "20261126000400_staff_performance_reports.sql",
 "20261126041500_project_assignments_and_deliverables.sql",
];
for(const [index,file] of dependencies.entries())copyFileSync(join(repo,"supabase","migrations",file),join(sandbox,"drizzle",String(100+index).padStart(4,"0")+"_"+file));
copyFileSync(join(repo,"public","payroll-font.ttf"),join(sandbox,"public","payroll-font.ttf"));
process.chdir(sandbox);
Object.assign(process.env,{
 WALSHKEN_STAFF_READINESS_ENABLED:"1", WALSHKEN_WORK_DATASET:"preview", WALSHKEN_TASK_DATASET:"preview",
 WALSHKEN_MANAGEMENT_REPORTS_ENABLED:"1", WALSHKEN_REQUIRE_STAFF_MFA:"0",
});
const RealDate=globalThis.Date, at=Date.parse("2026-04-07T12:30:00.000Z");
class TestDate extends RealDate {
 constructor(...args){super(...(args.length?args:[at]));}
 static now(){return at;}
}
globalThis.Date=TestDate;
const db=workspaceDatabase();
const write=(sql,...args)=>db.prepare(sql,args).run();
const row=(sql,...args)=>db.prepare(sql,args).first();
const org="walshken", ops="ops", service="service", month="2026-03", baseQuery="?month="+month;
const site="https://staff.walshken.test";

async function response(relative, actor, expected=200, data=undefined, origin=site) {
 const request = new Request(site+"/api/staff-performance"+relative,{
  method:data?"POST":"GET",headers:{origin,...(actor?{cookie:"walshken_session="+actor.token}:{}),
    ...(data?{"content-type":"application/json"}:{})}, body:data?JSON.stringify(data):undefined,
 });
 const result=await (data?POST(request):GET(request));
 if (result.status!==expected) assert.fail(`Expected ${expected}, received ${result.status}: ${await result.text()}`);
 return result;
}
const get=async (query,actor,expected)=> (await response(query,actor,expected)).json();
const post=async (data,actor,expected)=> (await response("",actor,expected,{month,...data})).json();
const time=(day,clock)=>`2026-03-${String(day).padStart(2,"0")}T${clock}:00.000Z`;

for(const [id,name] of [[org,"Walshken"],["other","Other company"]])
 await write("INSERT INTO organizations(id,name,time_zone) VALUES(?,?,'UTC')",id,name);
for(const [id,company,name] of [[ops,org,"Operations"],[service,org,"Service"],["otherDept","other","Other team"]])
 await write("INSERT INTO units(id,org_id,kind,name) VALUES(?,?,'Department',?)",id,company,name);

async function employee(id,name,role="employee",department=ops,company=org,employed="2025-01-01") {
 await write(`INSERT INTO employees(id,org_id,employee_no,name,email,role,title,department_id,country,jurisdiction,time_zone,hire_date)
 VALUES(?,?,?,?,?,?,'Analyst',?,'CA','CA-AB','America/Edmonton',?)`,id,company,id,name,id+"@example.test",role,department,employed);
 const token=randomUUID()+randomUUID();
 const signature=createHash("sha256").update(token).digest("hex");
 await write("INSERT INTO sessions(id,employee_id,expires_at,agent) VALUES(?,?,'2028-01-01T00:00:00Z','Performance test')",signature,id);
 return {id,token};
}
const admin=await employee("admin","Report Administrator","super_admin");
const reviewer=await employee("reviewer","Independent Reviewer","manager",service);
const staff=await employee("staff-a","Ada Quality");
const ben=await employee("staff-b","Ben Service","employee",service);
const chen=await employee("staff-c","Chen Progress");
const noLog=await employee("staff-missing","Missing Log");
const guest=await employee("guest","Account Guest","guest",service);
const outsider=await employee("another","Other Tenant","employee","otherDept","other");

async function permit(actor,action,scope="department",scopeId=ops,effect="allow"){
 await write(`INSERT INTO staff_action_permissions(id,org_id,principal_type,principal_id,action,scope_type,scope_id,effect,created_by,created_at)
 VALUES(?,?,'employee',?,?,?,?,?,?,?)`,randomUUID(),org,actor.id,action,scope,scopeId,effect,admin.id,time(1,"12:00"));
}
await permit(reviewer,"performance.read");
await permit(reviewer,"performance.export");
await permit(reviewer,"performance.export","employee",chen.id,"deny");
await permit(reviewer,"performance.manage");
await permit(reviewer,"performance.finalize");

async function shift(employee,day,options={}){
 const id="s-"+employee.id+"-"+day;
 const start=time(day,options.start??"15:00"), end=time(day,"23:00");
 await write(`INSERT INTO shifts
 (id,org_id,employee_id,starts_at,ends_at,title,location,created_by,state,time_zone,policy_snapshot,release_stage,workflow_version)
 VALUES(?,?,?,?,?,'Published shift','Office',?,?,'America/Edmonton',?,'preview',1)`,id,employee.id===outsider.id?"other":org,employee.id,start,end,admin.id,options.state??"Published",JSON.stringify({lateGrace:5}));
 if (options.checkIn) await write(`INSERT INTO attendance
  (id,org_id,employee_id,shift_id,starts_at,ends_at,time_zone,release_stage,workflow_version)
  VALUES(?,?,?,?,?,?,'America/Edmonton','preview',1)`,"a-"+id,employee.id===outsider.id?"other":org,employee.id,options.unlinked?null:id,time(day,options.checkIn),end);
 if (options.absence) await write(`INSERT INTO attendance_absences
  (id,org_id,release_stage,shift_id,employee_id,status,manual_excuse,recorded_at,updated_at)
  VALUES(?,?,'preview',?,?,?,?,?,?)`,"absence-"+id,org,id,employee.id,options.absence,options.absence==="Excused"?1:0,end,end);
}
await shift(staff,10,{checkIn:"14:55",unlinked:true});
await shift(staff,11,{checkIn:"15:03"});
await shift(staff,12,{checkIn:"15:23",start:"15:15"});
await shift(staff,13);
await shift(staff,14);
await shift(staff,15,{absence:"Excused"});
await shift(staff,16,{state:"Cancelled"});
await write(`INSERT INTO leave_requests(id,org_id,employee_id,category,starts_on,ends_on,status,release_stage)
 VALUES('leave',?,?,'Vacation','2026-03-13','2026-03-13','Approved','preview')`,org,staff.id);
await write(`INSERT INTO holidays(id,org_id,name,on_date,jurisdiction,type,release_stage)
 VALUES('holiday',?,'Observed company day','2026-03-14','CA-AB','Company','preview')`,org);
await shift(ben,18,{checkIn:"15:11"});
await shift(ben,19,{absence:"No show"});
await shift(chen,22,{checkIn:"15:00"});
await shift(noLog,23);
await shift(outsider,20,{checkIn:"15:00"});

async function task(id,employee,completion=null){
 await write(`INSERT INTO tasks(id,org_id,employee_id,assigned_by,title,description,priority,status,due_date,completed_at,created_at,release_stage,workflow_version)
 VALUES(?,?,?,?,'Monthly task','Evidence','Normal',?,'2026-03-25',?,?,'preview',1)`,id,org,employee.id,admin.id,completion?"Completed":"In Progress",completion,time(2,"12:00"));
}
await task("task-a1",staff,time(18,"16:00"));
await task("task-a2",staff);
await task("task-c1",chen);
await write(`INSERT INTO projects(id,org_id,owner_id,name,description,status,due_on,completed_at,created_at)
 VALUES('project',?,?,'Project milestone report','Evidence','Completed','2026-03-24',?,?)`,org,admin.id,time(22,"15:00"),time(1,"12:00"));
await write(`INSERT INTO project_assignments(id,org_id,project_id,employee_id,assigned_by,assigned_at,unassigned_by,unassigned_at)
 VALUES('original',?,'project',?,?,?,?,?)`,org,staff.id,admin.id,time(1,"13:00"),admin.id,time(23,"12:00"));
await write(`INSERT INTO project_assignments(id,org_id,project_id,employee_id,assigned_by,assigned_at)
 VALUES('reassignment',?,'project',?,?,?)`,org,staff.id,admin.id,time(24,"12:00"));
await write(`INSERT INTO project_assignments(id,org_id,project_id,employee_id,assigned_by,assigned_at,unassigned_by,unassigned_at)
 VALUES('previous',?,'project',?,?,?,?,?)`,org,chen.id,admin.id,time(1,"13:00"),admin.id,time(20,"12:00"));
await write(`INSERT INTO project_milestones(id,project_id,title,due_on,assignee_id,completed_at,completed_by,created_by,created_at)
 VALUES('milestone','project','Review','2026-03-20',?,?,?,?,?)`,staff.id,time(19,"16:00"),staff.id,admin.id,time(2,"12:00"));

await get(baseQuery,null,401);
await get(baseQuery,staff,403);
await get(baseQuery,guest,403);
await get(baseQuery+"&employee="+outsider.id,admin,403);
await get(baseQuery+"&format=csv",staff,403);
await get(baseQuery+"&photo="+outsider.id,admin,403);
await response("",admin,403,{month,action:"model-save"},"https://other.example.test");
process.env.WALSHKEN_REQUIRE_STAFF_MFA="1";
await get(baseQuery,admin,403);
process.env.WALSHKEN_REQUIRE_STAFF_MFA="0";
const initial=await get(baseQuery,admin);
assert.deepEqual(initial.leaders.map(row=>row.name),["Ada Quality","Chen Progress","Ben Service"]);
assert.equal(initial.leaders[0].score,80);
assert.equal(initial.leaders[0].attendance.attendancePercent,100);
assert.equal(initial.leaders[0].attendance.punctualityPercent,66.7);
assert.equal(initial.leaders[0].attendance.early,1);
assert.equal(initial.leaders[0].attendance.onTime,1);
assert.equal(initial.leaders[0].attendance.late,1);
assert.equal(initial.leaders[0].attendance.absent,0);
assert.equal(initial.leaders[0].attendance.excluded,3);
assert.deepEqual(initial.leaders[0].projects,{due:1,completed:1,completedThisMonth:1,percent:100},
 "Reassignments must not double-count a project completed during a previous assignment");
assert.equal(initial.leaders[0].milestones.percent,100);
assert.equal(initial.leaders[1].projects.due,0);
assert.equal(initial.leaders[2].attendance.absent,1);
assert.equal(initial.employees.find(row=>row.id===noLog.id).score,null);
assert.equal(initial.employees.find(row=>row.id===noLog.id).attendance.missing,1);
assert(initial.trends.find(row=>row.month===month).attendance.late>0);
assert(!initial.arrival.find(row=>row.id==="s-"+staff.id+"-16"));
assert.equal(initial.arrival.find(row=>row.id==="s-"+staff.id+"-12").differenceMinutes,8);
const scoped=await get(baseQuery,reviewer);
assert(scoped.people.every(row=>row.departmentId===ops));
assert(!scoped.employees.find(row=>row.id===ben.id));
const department=await get(baseQuery+"&department="+service+"&q=ben",admin);
assert.deepEqual(department.employees.map(row=>row.id),[ben.id]);
const csv=await response(baseQuery+"&format=csv",reviewer);
const body=await csv.text();
assert.match(body,/Ada Quality/);
assert(!body.includes("Chen Progress"),"Export deny must take precedence over department grant");
assert(!body.includes("Other Tenant"));
await get(baseQuery+"&format=csv&employee="+chen.id,reviewer,403);
const arrivalCsv=await response(baseQuery+"&format=csv&report=arrival&employee="+staff.id,reviewer);
assert.match(await arrivalCsv.text(),/"-5","5","Early"/);
await write(`INSERT INTO tasks(id,org_id,employee_id,assigned_by,title,description,priority,status,due_date,task_timezone,created_at,release_stage,workflow_version)
 VALUES('due-today',?,?,?,'Due today','Evidence','Normal','In Progress','2026-04-07','Asia/Karachi',?,'preview',1)`,org,staff.id,admin.id,time(28,"12:00"));
assert.equal((await get("?month=2026-04&employee="+staff.id,admin)).employees[0].tasks.due,0,
 "An open item due today must not reduce the score before the task's local deadline ends");
const pdf=await response(baseQuery+"&format=pdf&report=arrival&employee="+staff.id,reviewer);
assert.equal(pdf.headers.get("content-type"),"application/pdf");
assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,4).toString(),"%PDF");
console.log("PASS database-based top three, weighted scores, scoped rankings, UTC arrivals and grace, exclusions, missing data, project assignments, cross-tenant/audited export boundaries and PDF");

const weights={attendance:40,punctuality:20,tasks:15,projects:5,milestones:10,review:5,quality:5};
await post({action:"model-save",reason:"Scoped manager cannot define global weights",weights},reviewer,403);
await post({action:"model-save",reason:"Reject invalid total",weights:{...weights,attendance:41}},admin,400);
await post({action:"model-save",reason:"Verified scoring formula",weights},admin);
await post({action:"assessment-submit",employee:staff.id,reviewScore:90,qualityScore:80,evidence:"Documented work sample and supervisor evidence"},admin);
const awaiting=(await get(baseQuery+"&employee="+staff.id,admin)).assessments[0];
assert.equal(awaiting.decision,null);
await post({action:"assessment-decide",id:awaiting.id,decision:"Approved",reason:"Self review blocked"},admin,403);
await post({action:"assessment-decide",id:awaiting.id,decision:"Approved",reason:"Independently matched documented indicators"},reviewer);
const current=await get(baseQuery,admin);
assert.equal(current.leaders.length,1);
assert.equal(current.leaders[0].score,84.3);
assert.equal(current.leaders[0].review,90);
assert.equal(current.leaders[0].quality,80);
await post({action:"finalize",confirm:true},reviewer,403);
await post({action:"finalize",confirm:true,month:"2026-04"},admin,409);
await post({action:"finalize",confirm:false},admin,400);
await post({action:"finalize",confirm:true},admin);
await write("UPDATE attendance SET starts_at=? WHERE id=?",time(12,"15:15"),"a-s-"+staff.id+"-12");
const saved=await get(baseQuery,admin);
assert(saved.finalizedAt);
assert.equal(saved.leaders[0].score,84.3);
assert.equal(saved.arrival.find(row=>row.id==="s-"+staff.id+"-12").differenceMinutes,8);
await post({action:"model-save",reason:"Cannot revise closed month",weights},admin,409);
await assert.rejects(write("UPDATE staff_performance_reports SET snapshot='{}' WHERE month=?",month),/immutable/);
const events=await row("SELECT count(*)::int AS total FROM audit WHERE org_id=? AND entity='performance report'",org);
assert(events.total>5);
console.log("PASS effective and validated weights, independent evidence approval, protected month closure, frozen history, immutable database records and audit history");
globalThis.Date=RealDate;
process.exit(0);
