import assert from "node:assert/strict";
import {defaultPolicy} from "../lib/walshken/attendance-rules.ts";

export async function verifyFinalOperations({db,request,admin,staff,hr,adminId,staffId,runId}) {
 process.env.WALSHKEN_PROJECT_LIFECYCLE_ENABLED="1";
 const name="Verified rollout "+runId;
 const plan={owner:staffId,name,description:"Review rollout deliverables",start:"2026-11-01",due:"2026-11-30"};
 await request("projects/add",403,staff,plan);
 const project=(await request("projects/add",201,admin,plan)).id;
 assert.equal((await request("view/projects?q="+runId,200,staff)).rows.find(row=>row.id===project).can_manage,0);
 await request("projects/milestone-add",400,admin,{id:project,revision:1,title:"Review",due:"2026-12-01"});
 await request("projects/milestone-add",200,admin,{id:project,revision:1,title:"Review",due:"2026-11-12"});
 await request("projects/submit",409,admin,{id:project,revision:1});
 await request("projects/submit",409,admin,{id:project,revision:2});
 const view=await request("view/projects?q="+runId+"&order=Deadline",200,admin);
 assert.equal(view.total,1);
 const milestone=view.milestones.find(row=>row.project_id===project);
 await request("projects/milestone-complete",200,admin,{id:project,revision:2,milestone:milestone.id});
 await request("projects/submit",200,admin,{id:project,revision:3});
 await request("projects/review",403,admin,{id:project,revision:4,decision:"Approve",reason:"Ready"});
 await request("projects/review",200,hr,{id:project,revision:4,decision:"Return",reason:"Confirm delivery"});
 await request("projects/submit",200,admin,{id:project,revision:5});
 await request("projects/review",200,hr,{id:project,revision:6,decision:"Approve",reason:"All evidence reviewed"});
 await request("projects/archive",200,admin,{id:project,revision:7});
 await request("projects/restore",200,admin,{id:project,revision:8});
 const restored=(await request("view/projects?status=Completed&q="+runId,200,admin)).rows.find(row=>row.id===project);
 assert(restored.completed_at);
 assert.equal(restored.revision,9);
 console.log("PASS project visibility, milestone dates, blockers, stale writes, independent approval, search, archive and restore");

 const query=(sql,...values)=>db.prepare(sql,values).run();
 const attendance="final-a-"+runId,shift="final-s-"+runId,excused="final-x-"+runId;
 await query(`INSERT INTO attendance(id,org_id,employee_id,starts_at,ends_at,time_zone,release_stage,workflow_version,policy_snapshot)
  VALUES(?,'walshken',?,'2026-02-10T15:00:00.000Z','2026-02-10T23:00:00.000Z','America/Edmonton','preview',1,?)`,attendance,staffId,JSON.stringify(defaultPolicy()));
 for(const [id,day] of [[shift,11],[excused,12]])await query(`INSERT INTO shifts(id,org_id,employee_id,starts_at,ends_at,title,location,created_by,time_zone,release_stage,workflow_version)
  VALUES(?,'walshken',?,?,?,'Scheduled','HQ',?,'America/Edmonton','preview',1)`,id,staffId,`2026-02-${day}T15:00:00.000Z`,`2026-02-${day}T23:00:00.000Z`,adminId);
 await query(`INSERT INTO attendance_absences(id,org_id,release_stage,shift_id,employee_id,status,manual_excuse,recorded_at,updated_at)
  VALUES(?,'walshken','preview',?,?,'Excused',1,'2026-02-12T23:00:00.000Z','2026-02-12T23:00:00.000Z')`,'excused-'+runId,excused,staffId);
 const list=await request("view/approvals?from=2026-02-10&to=2026-02-12&exceptions=1&team=1",200,admin);
 assert.equal(list.workExceptions.find(row=>row.id===attendance)?.issue,"Missing timesheet");
 assert.equal(list.workExceptions.find(row=>row.id===shift)?.issue,"Attendance follow-up");
 assert(!list.workExceptions.some(row=>row.id===excused));
 const unrelated=await request("view/timesheets?from=2026-02-10&to=2026-02-12&exceptions=1",200,hr);
 assert(!unrelated.workExceptions.some(row=>row.id===attendance));
 console.log("PASS missing attendance and timesheet drill-down, excused exclusion and personal scope");

 const assignment={employee:staffId,country:"CA",region:"CA-ON",jurisdiction:"CA-ON",effectiveOn:"2027-01-01",
  classification:"Verified coverage example",city:"Toronto",timeZone:"America/Toronto",employmentType:"Full-time",
  employeeCategory:"Employee",compensationType:"Hourly",currency:"CAD",frequency:"Biweekly",expectedHours:40,schedule:"Monday through Friday",
  reference:"Synthetic declaration of actual worksite and jurisdiction for the isolated test"};
 await request("governance/employment-terms-save",400,admin,{...assignment,region:"CA-FED",jurisdiction:"CA-FED"});
 await request("governance/employment-terms-save",400,admin,{...assignment,jurisdiction:"CA-AB"});
 await request("governance/employment-terms-save",201,admin,assignment);
 const coverage=await request("governance/employment-coverage",200,admin,{employee:staffId,day:"2027-01-01"});
 assert.equal(coverage.assignment.workplace,"CA-ON");
 assert(coverage.coverage.some(row=>row.category==="Canada payroll"&&row.version==="CRA-T4127-2027-ON-JAN-v1"));
 assert(coverage.coverage.some(row=>row.category==="Leave"&&row.status==="Pending legal verification"));
 assert(!coverage.coverage.some(row=>row.category==="India payroll"||row.category==="Pakistan payroll"));
 await request("governance/employment-coverage",403,staff,{employee:staffId,day:"2027-01-01"});
 console.log("PASS authenticated, Super Admin-only employment coverage inspection");
}
