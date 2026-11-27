import assert from "node:assert/strict";
import {defaultPolicy,dayAdd} from "../lib/walshken/attendance-rules.ts";

export async function verifyFinalOperations({db,request,admin,staff,hr,person,adminId,staffId,runId}) {
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
 await request("projects/review",404,hr,{id:project,revision:4,decision:"Return",reason:"Confirm delivery"});
 await request("governance/permission-save",200,admin,{principalType:"employee",principal:hr.id,scopeType:"employee",
  scopeId:staffId,capability:"projects.review",effect:"allow"});
 await request("projects/review",200,hr,{id:project,revision:4,decision:"Return",reason:"Confirm delivery"});
 await request("projects/submit",200,admin,{id:project,revision:5});
 await request("projects/review",200,hr,{id:project,revision:6,decision:"Approve",reason:"All evidence reviewed"});
 await request("projects/archive",200,admin,{id:project,revision:7});
 await request("projects/restore",200,admin,{id:project,revision:8});
 const csv=await request("view/projects?export=1&q="+runId,200,admin);
 assert.match(csv.toString(),/Overdue milestones/);
 assert(csv.toString().includes(name));
 await request("view/projects?export=1",403,staff);
 await request("governance/permission-save",200,admin,{principalType:"employee",principal:staffId,scopeType:"employee",
  scopeId:staffId,capability:"projects.read",effect:"deny"});
 assert(!(await request("view/projects?q="+runId,200,staff)).rows.some(row=>row.id===project));
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

 const coverageDay=`${Math.max(2027,new Date().getUTCFullYear()+1)}-01-01`;
 const assignment={employee:staffId,country:"CA",region:"CA-ON",jurisdiction:"CA-ON",effectiveOn:coverageDay,
  classification:"Verified coverage example",city:"Toronto",timeZone:"America/Toronto",employmentType:"Full-time",
  employeeCategory:"Employee",compensationType:"Hourly",currency:"CAD",frequency:"Biweekly",expectedHours:40,schedule:"Monday through Friday",
  reference:"Synthetic declaration of actual worksite and jurisdiction for the isolated test"};
 await request("governance/employment-terms-save",400,admin,{...assignment,region:"CA-FED",jurisdiction:"CA-FED"});
 await request("governance/employment-terms-save",400,admin,{...assignment,jurisdiction:"CA-AB"});
 await request("governance/employment-terms-save",201,admin,assignment);
 const coverage=await request("governance/employment-coverage",200,admin,{employee:staffId,day:coverageDay});
 assert.equal(coverage.assignment.workplace,"CA-ON");
 assert(coverage.coverage.some(row=>row.category==="Canada payroll"&&row.status==="Payment-date package required"));
 assert(coverage.coverage.some(row=>row.category==="Leave"&&row.status==="Pending legal verification"));
 assert(!coverage.coverage.some(row=>row.category==="India payroll"||row.category==="Pakistan payroll"));
 await request("governance/employment-coverage",403,staff,{employee:staffId,day:coverageDay});
 console.log("PASS authenticated, Super Admin-only employment coverage inspection");
 await verifyDatedLeave({db,request,admin,person,adminId,runId});
 const {verifyProjectManagement}=await import("./verify-project-management.mjs");
 await verifyProjectManagement({db,request,admin,staff,hr,person,adminId,staffId,runId});

}

async function verifyDatedLeave({db,request,admin,person,adminId,runId}) {
 const reviewer=await person("admin","Leave legal reviewer","CARRY-REVIEW-"+runId);
 const worker=await person("employee","Dated leave employee","CARRY-STAFF-"+runId);
 await db.prepare("UPDATE employees SET role='super_admin' WHERE id=?",[reviewer.id]).run();
 const year=new Date().getUTCFullYear(),newYear=year+"-01-01",oldYear=(year-1)+"-01-01",yearEnd=year+"-12-31";
 const category="Regional leave test "+runId;
 const write=(sql,...values)=>db.prepare(sql,values).run();
 await write("UPDATE employees SET hire_date=? WHERE id=?",oldYear,worker.id);
 await write(`INSERT INTO staff_employment_terms(id,org_id,employee_id,effective_on,country,region_code,jurisdiction,classification,city,time_zone,employment_type,category,
  compensation_type,currency,frequency,expected_hours,schedule,reference,created_by,created_at)
  VALUES(?,'walshken',?,?,'IN','IN-DL','IN-DL',?,'Delhi','Asia/Kolkata','Full-time','Employee','Hourly','INR','Monthly',40,'Test shift','Synthetic applicability evidence',?,?)`,"carry-terms-"+runId,worker.id,oldYear,category,adminId,new Date().toISOString());
 async function approve(type,settings,version,from=oldYear,predecessor=""){
  await request("governance/employment-policy-save",201,admin,{jurisdiction:"IN-DL",classification:category,category:type,version,
   effectiveFrom:from,effectiveThrough:yearEnd,source:"https://labour.gov.in/",evidence:"Synthetic calculation acceptance fixture",mandatory:true,settings,predecessor});
  const row=(await request("view/governance",200,admin)).employment.policies.find(row=>row.version===version);
  await request("governance/jurisdiction-verify",200,reviewer,{id:row.id,reason:"Independent verification of synthetic settings"});
  return row.id;
 }
 const free={code:"VAC",name:"Vacation",paid:true,annualMinutes:4800,carryMinutes:960,accrual:"Annual",minimumServiceDays:0,reviewCarry:true};
 const worked={code:"WORK",name:"Workday earned",paid:true,annualMinutes:9000,carryMinutes:0,accrual:"Approved workdays",minimumServiceDays:0,daysPerCredit:2,minimumApprovedDays:2};
 const daily={code:"DAILY",name:"Daily earned",paid:true,annualMinutes:3650,carryMinutes:0,accrual:"Daily earned",minimumServiceDays:0};
 const policy={workdays:[0,1,2,3,4,5,6],dayMinutes:480,yearStartMonth:1,proration:"None",categories:[free,worked,daily]};
 await approve("Holiday calendar",{dates:[]},"Carry calendar "+runId);
 const prior=await approve("Leave",policy,"Leave initial "+runId);
 const {employeeLeaveBalances,validateLeaveRequest,payrollLeaveEntitlement}=await import("../lib/walshken/leave-balances.ts");
 const employee=await db.prepare("SELECT * FROM employees WHERE id=?",[worker.id]).first();
 const carry={employee:worker.id,code:"VAC",effectiveOn:newYear};
 await request("governance/employment-leave-carry",409,admin,{...carry,effectiveOn:dayAdd(newYear,1)});
 assert.match((await request("governance/employment-leave-carry",201,admin,carry)).message,/960/);
 await request("governance/employment-leave-carry",409,admin,carry);
 const row=(await request("view/governance",200,admin)).employment.leaveAdjustments.find(row=>row.employee_id===worker.id&&row.code==="VAC");
 const review={id:row.id,decision:"Approved",reason:"Verified previous year balance"};
 await request("governance/employment-leave-adjust-review",403,admin,review);
 await request("governance/employment-leave-adjust-review",200,reviewer,review);
 const next=await employeeLeaveBalances(db,employee,newYear);
 assert.equal(next.balances.find(item=>item.code==="VAC").available,5760);

 for(const [idx,day] of [year+"-02-02",year+"-02-02",year+"-02-03"].entries()){
  const id="earned-"+idx+"-"+runId,start=idx===1?"05:00":"04:00",end=idx===1?"05:45":"04:45";
  await write(`INSERT INTO attendance(id,org_id,employee_id,starts_at,ends_at,time_zone,release_stage,workflow_version)
   VALUES(?,'walshken',?,?,?,'Asia/Kolkata','preview',1)`,id,worker.id,day+"T"+start+":00.000Z",day+"T"+end+":00.000Z");
  await write(`INSERT INTO timesheets(id,attendance_id,org_id,employee_id,work_date,gross_seconds,unpaid_seconds,paid_seconds,status,release_stage,workflow_version)
   VALUES(?,?,'walshken',?,?,2700,0,2700,'Approved','preview',1)`,"sheet-"+id,id,worker.id,day);
 }
 const firstBalance=await employeeLeaveBalances(db,employee,year+"-02-02");
 const secondBalance=await employeeLeaveBalances(db,employee,year+"-02-03");
 assert.equal(firstBalance.balances.find(item=>item.code==="WORK").available,0,"Two approved intervals on a day are one qualifying day");
 assert.equal(secondBalance.balances.find(item=>item.code==="WORK").available,480);
 const cut=year+"-07-01";
 await approve("Leave",{...policy,categories:[{...free,paid:false},worked,{...daily,annualMinutes:7300}]},"Leave successor "+runId,cut,prior);
 const reviewed=await validateLeaveRequest(db,employee,dayAdd(cut,-1),cut,"VAC");
 const slices=JSON.parse(reviewed.snapshot);
 assert.equal(reviewed.minutes,960);assert.equal(slices.rules.length,2);
 assert.deepEqual(slices.days.map(row=>row.paid),[true,false]);
 assert.deepEqual(payrollLeaveEntitlement(reviewed.snapshot,cut),{paid:false,seconds:28800});
 assert.throws(()=>payrollLeaveEntitlement(reviewed.snapshot,dayAdd(cut,1)),/no payable or unpaid allocation/);
 const earned=await employeeLeaveBalances(db,employee,cut);
 const elapsed=(Date.parse(cut)-Date.parse(newYear))/86400000;
 const daysInYear=1+(Date.parse(yearEnd)-Date.parse(newYear))/86400000;
 assert.equal(earned.balances.find(item=>item.code==="DAILY").entitlement,Math.floor((elapsed*3650+7300)/daysInYear));
 console.log("PASS verified leave rollover and independent approval, counted workdays, dated accrual and frozen mixed-rule requests");
}
