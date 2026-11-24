import {all,id,json,now,one,run,type Actor,type Db} from './server';
import {workDataset,workEvent,workNotify,notifyManagers,type Shift} from './workforce';
import {localDate} from './work';
export async function maintainReviewAttendance(db:Db,actor:Actor){return db.transaction(async tx=>{
 await one(tx,'SELECT id FROM organizations WHERE id=? FOR UPDATE',actor.org_id);let absent=0,reminders=0;
 const shifts=await all<Shift&{org_id:string}>(tx,"SELECT s.* FROM shifts s JOIN employees e ON e.id=s.employee_id WHERE s.org_id=? AND s.release_stage=? AND s.workflow_version=1 AND s.state='Published' AND s.ends_at<? AND e.status='Active' AND e.employment_status<>'Ended' ORDER BY s.ends_at LIMIT 5000",actor.org_id,workDataset(),now());
 if(shifts.length===5000)return json({ok:false,message:'Too many historical shifts for one maintenance run. Review a narrower schedule range.'},409);
 for(const shift of shifts){
  const employee=await one<Actor>(tx,'SELECT * FROM employees WHERE id=?',shift.employee_id);if(!employee)continue;const existing=await one<{id:string;status:string;manual_excuse:number}>(tx,'SELECT * FROM attendance_absences WHERE shift_id=?',shift.id),worked=await one(tx,'SELECT id FROM attendance WHERE employee_id=? AND release_stage=? AND starts_at<? AND (ends_at IS NULL OR ends_at>?)',employee.id,workDataset(),shift.ends_at,shift.starts_at),day=localDate(shift.starts_at,shift.time_zone),leave=await one(tx,"SELECT id FROM leave_requests WHERE employee_id=? AND release_stage=? AND status='Approved' AND starts_on<=? AND ends_on>=?",employee.id,workDataset(),day,day),status=worked?'Resolved':leave?'Excused':'No show';
  if(existing?.manual_excuse)continue;if(worked&&!existing)continue;
  if(existing){if(existing.status!==status)await run(tx,'UPDATE attendance_absences SET status=?,updated_at=? WHERE id=?',status,now(),existing.id);continue;}
  const target=id();await run(tx,'INSERT INTO attendance_absences(id,org_id,release_stage,shift_id,employee_id,status,recorded_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',target,actor.org_id,workDataset(),shift.id,employee.id,status,now(),now());await workEvent(tx,actor,employee.id,'absence',target,'Scheduled attendance checked',{shiftId:shift.id,status,day});if(status==='No show'){absent++;await notifyManagers(tx,actor,employee,'Scheduled attendance needs review',employee.name+' · '+day+' · No matching work or approved leave.','reports');}
 }
 const open=await all<{id:string;employee_id:string;starts_at:string}>(tx,'SELECT id,employee_id,starts_at FROM attendance WHERE org_id=? AND release_stage=? AND ends_at IS NULL AND starts_at<?',actor.org_id,workDataset(),new Date(Date.now()-16*3600000).toISOString());
 for(const entry of open){const href='/staff/attendance?entry='+entry.id;if(await one(tx,'SELECT id FROM notifications WHERE employee_id=? AND href=? AND release_stage=?',entry.employee_id,href,workDataset()))continue;await run(tx,'INSERT INTO notifications(id,employee_id,title,body,href,release_stage) VALUES(?,?,?,?,?,?)',id(),entry.employee_id,'Review a missed clock-out','An attendance clock has been open for more than sixteen hours. Submit the actual finish time for approval.',href,workDataset());reminders++;}
 return json({ok:true,message:'Attendance maintenance completed in this isolated review dataset.',result:{newAbsences:absent,missedClockOutReminders:reminders}});
 });}
