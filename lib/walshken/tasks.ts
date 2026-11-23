import { all,canManage,canSuper,date,fail,id,integer,json,now,one,pick,requireStaff,run,scope,str,throttle,type Actor,type Db } from "./server";
import { localDate } from "./work";
import { activeTaskStatuses,taskPriorities,type TaskItem,type TaskTimeEntry } from "./task-types";
import { documentContext,documentMask,requireDocumentPermission } from "./document-access";
import { permissionBit } from "./document-types";

export const tasksEnabled=()=>process.env.WALSHKEN_TASKS_ENABLED==="1";
export const taskDataset=()=>process.env.WALSHKEN_TASK_DATASET==="preview"?"preview":"production";
export function requireTasks(actor:Actor){if(!tasksEnabled())return fail(404,"Task management is not enabled on this deployment.");requireStaff(actor);}
export async function taskEvent(db:Db,actor:Actor,target:string,action:string,detail=""){
 await run(db,"INSERT INTO task_events(id,org_id,task_id,actor_id,action,detail,created_at) VALUES(?,?,?,?,?,?,?)",id(),actor.org_id,target,actor.id,action,detail.slice(0,1500),now());
}
export async function taskNotify(db:Db,actor:Actor,target:string,employee:string,title:string,body:string){
 await run(db,"INSERT INTO notifications(id,employee_id,title,body,href,release_stage) VALUES(?,?,?,?,?,?)",id(),employee,title.slice(0,150),body.slice(0,500),`/staff/tasks?task=${target}`,taskDataset());
}
export async function taskFor(db:Db,actor:Actor,target:string,lock=false){
 requireTasks(actor);const scoped=scope(actor,"e");
 const item=await one<TaskItem>(db,`SELECT t.* FROM tasks t JOIN employees e ON e.id=t.employee_id AND e.org_id=t.org_id
 WHERE t.id=? AND t.org_id=? AND t.release_stage=? AND t.workflow_version=1 AND ${scoped.sql}${lock?" FOR UPDATE OF t":""}`,target,actor.org_id,taskDataset(),...scoped.args);
 if(!item)return fail(404,"This task is unavailable or outside your current scope.");return item;
}
function taskOpen(task:TaskItem){if(!activeTaskStatuses.includes(task.status as typeof activeTaskStatuses[number]))return fail(409,"Reopen or return this task before changing its work records.");}
const checkRevision=(task:TaskItem,value:unknown)=>{if(integer(value,"task revision",1,2147483647)!==task.revision)return fail(409,"This task changed. Refresh before saving.");};
async function taskEmployee(db:Db,actor:Actor,target:string){
 const employee=await one<Actor>(db,"SELECT * FROM employees WHERE id=? AND org_id=? AND status='Active' AND employment_status<>'Ended' AND role<>'guest'",target,actor.org_id);
 if(!employee)return fail(404,"Choose an active staff member.");const scoped=scope(actor,"e");
 if(!await one(db,`SELECT id FROM employees e WHERE e.id=? AND e.org_id=? AND ${scoped.sql}`,employee.id,actor.org_id,...scoped.args))return fail(403,"That employee is outside your assignment scope.");return employee;
}
async function eligibleReviewer(db:Db,actor:Actor,employee:Actor,target:string){
 if(!target)return fail(400,"Choose a reviewer for this task.");
 const reviewer=await one<Actor>(db,"SELECT * FROM employees WHERE id=? AND org_id=? AND status='Active' AND employment_status<>'Ended'",target,actor.org_id);
 if(!reviewer||!canManage(reviewer)||reviewer.id===employee.id)return fail(400,"Choose a different active manager to review this employee's work.");
 const scoped=scope(reviewer,"e",false);if(!await one(db,`SELECT id FROM employees e WHERE e.id=? AND e.org_id=? AND ${scoped.sql}`,employee.id,actor.org_id,...scoped.args))return fail(403,"The reviewer does not have current management access to this employee.");return reviewer.id;
}
async function validProject(db:Db,actor:Actor,target:string){
 if(!target)return null;
 const project=await one(db,`SELECT p.id FROM projects p WHERE p.id=? AND p.org_id=? AND p.status='Active'
 AND (?=1 OR p.owner_id=? OR (p.department_id IS NOT NULL AND p.department_id=?) OR EXISTS(SELECT 1 FROM tasks t WHERE t.project_id=p.id AND t.employee_id=? AND t.release_stage=?))`,target,actor.org_id,canSuper(actor)?1:0,actor.id,actor.department_id,actor.id,taskDataset());
 if(!project)return fail(403,"That project reference is outside your authorized scope.");return target;
}
export async function taskTotals(db:Db,target:string){
 await run(db,"UPDATE tasks SET actual_minutes=COALESCE((SELECT SUM(seconds)/60 FROM task_time_entries WHERE task_id=? AND voided_at IS NULL),0) WHERE id=?",target,target);
}
export async function stopTaskTimer(db:Db,actor:Actor,task:TaskItem,reason:string){
 const entries=await all<TaskTimeEntry>(db,"SELECT * FROM task_time_entries WHERE task_id=? AND kind='Timer' AND ends_at IS NULL AND voided_at IS NULL FOR UPDATE",task.id);
 for(const entry of entries){const end=Math.min(Date.now(),Date.parse(entry.starts_at!)+43200000),other=await one<{seconds:number}>(db,"SELECT COALESCE(SUM(seconds),0)::int AS seconds FROM task_time_entries WHERE employee_id=? AND worked_on=? AND id<>? AND voided_at IS NULL",entry.employee_id,entry.worked_on,entry.id),seconds=Math.max(0,Math.min(86400-(other?.seconds??0),Math.floor((end-Date.parse(entry.starts_at!))/1000)));
  await run(db,"UPDATE task_time_entries SET ends_at=?,seconds=?,updated_at=? WHERE id=?",new Date(end).toISOString(),seconds,now(),entry.id);await taskEvent(db,actor,task.id,"Timer stopped",`${reason}; ${seconds} seconds`);
 }if(entries.length)await taskTotals(db,task.id);
}
function estimate(value:unknown){const hours=Number(value??0);if(!Number.isFinite(hours)||hours<0||hours>10000||Math.abs(hours*60-Math.round(hours*60))>.001)return fail(400,"Enter estimated hours in whole-minute increments, up to 10,000 hours.");return Math.round(hours*60);}
function taskDates(data:Record<string,unknown>){const start=date(data.startDate,"start date",false),due=date(data.dueDate,"due date",false);if(start&&due&&due<start)return fail(400,"Due date must be on or after the start date.");return {start,due};}
async function linkedDocumentsAccessible(db:Db,employee:Actor,target:string){
 const links=await all<{document_id:string}>(db,"SELECT document_id FROM task_document_links WHERE task_id=?",target);
 for(const link of links){try{await requireDocumentPermission(db,employee,await documentContext(db,employee,link.document_id),"view");}catch{return fail(409,"The new assignee cannot open a linked library document. Update its permissions or unlink it first.");}}
}
export async function taskAction(db:Db,actor:Actor,action:string,data:Record<string,unknown>){
 requireTasks(actor);await throttle(db,`task-action:${actor.id}`,120,60000);
 if(action==="detail")return taskDetail(db,actor,str(data.id,"task",80),Math.max(1,Number(data.commentPage)||1));
 if(action==="list")return taskDashboard(db,actor,new URLSearchParams(Object.entries(data).map(([key,value])=>[key,String(value)])));
 if(action==="maintenance"){
  if(!canSuper(actor))return fail(403,"Task maintenance requires a Super Admin.");
  const maintenance = taskDataset()==="preview"
    ? "SELECT walshken_private.task_review_maintenance() AS result"
    : "SELECT walshken_private.task_production_maintenance() AS result";
  return json({ok:true,result:await one(db,maintenance),message:"Overdue tasks and open timers checked."});
 }
 return db.transaction(async tx=>{
  // Lock in one order across task updates, time records and assignment changes.
  await one(tx,"SELECT id FROM organizations WHERE id=? FOR UPDATE",actor.org_id);
  if(action==="assign"){
   if(!canManage(actor))return fail(403,"Task assignment requires a manager.");
   const employee=await taskEmployee(tx,actor,str(data.employee,"assignee",80)),reviewer=await eligibleReviewer(tx,actor,employee,str(data.reviewer,"reviewer",80));
   const {start,due}=taskDates(data),project=await validProject(tx,actor,str(data.project,"project",80,false)),target=id(),title=str(data.title,"task title",150),at=now();
   await run(tx,`INSERT INTO tasks(id,org_id,employee_id,assigned_by,project_id,title,description,priority,start_date,due_date,estimate_minutes,
    department_id,division_id,client_reference,reviewer_id,task_timezone,release_stage,workflow_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    target,actor.org_id,employee.id,actor.id,project,title,str(data.description,"description",5000,false),pick(data.priority??"Normal",taskPriorities,"priority"),start,due,estimate(data.estimatedHours),employee.department_id,employee.division_id,str(data.clientReference,"client reference",180,false),reviewer,employee.time_zone,taskDataset(),at,at);
   await taskEvent(tx,actor,target,"Assigned",`${employee.name}; reviewer ${reviewer}`);await taskNotify(tx,actor,target,employee.id,"Task assigned",title);
   return json({ok:true,id:target,message:"Task assigned."},201);
  }
  const task=await taskFor(tx,actor,str(data.id,"task",80),true),manager=canManage(actor),owns=task.employee_id===actor.id;
  if(action==="comment"){
   const body=str(data.body,"comment",3000);await run(tx,"INSERT INTO task_notes(id,org_id,task_id,author_id,body,created_at) VALUES(?,?,?,?,?,?)",id(),actor.org_id,task.id,actor.id,body,now());
   await taskEvent(tx,actor,task.id,"Comment added");const recipient=owns?task.reviewer_id:task.employee_id;
   if(recipient&&recipient!==actor.id){const user=await one<Actor>(tx,"SELECT * FROM employees WHERE id=? AND org_id=? AND status='Active' AND employment_status<>'Ended'",recipient,actor.org_id);if(user)try{await taskFor(tx,user,task.id);await taskNotify(tx,actor,task.id,recipient,"Task discussion updated",task.title);}catch{/* Former reviewers are not notified. */}}
   return json({ok:true,message:"Comment added."},201);
  }
  if(action==="edit"){
   if(!manager)return fail(403,"Only an authorized manager may change an assignment.");taskOpen(task);checkRevision(task,data.revision);
   const employee=await taskEmployee(tx,actor,str(data.employee,"assignee",80)),reviewer=await eligibleReviewer(tx,actor,employee,str(data.reviewer,"reviewer",80));
   const {start,due}=taskDates(data),projectInput=str(data.project,"project",80,false),project=projectInput===task.project_id?task.project_id:await validProject(tx,actor,projectInput);
   if(employee.id!==task.employee_id){await linkedDocumentsAccessible(tx,employee,task.id);await stopTaskTimer(tx,actor,task,"Assignment changed");}
   await run(tx,`UPDATE tasks SET employee_id=?,project_id=?,title=?,description=?,priority=?,start_date=?,due_date=?,estimate_minutes=?,department_id=?,division_id=?,client_reference=?,reviewer_id=?,task_timezone=?,updated_at=?,revision=revision+1 WHERE id=?`,
    employee.id,project,str(data.title,"task title",150),str(data.description,"description",5000,false),pick(data.priority,taskPriorities,"priority"),start,due,estimate(data.estimatedHours),employee.department_id,employee.division_id,str(data.clientReference,"client reference",180,false),reviewer,employee.time_zone,now(),task.id);
   await taskEvent(tx,actor,task.id,"Assignment updated",`Assignee ${task.employee_id} → ${employee.id}; department ${employee.department_id??"none"}; division ${employee.division_id??"none"}`);await taskNotify(tx,actor,task.id,employee.id,"Task updated",str(data.title,"task title",150));
   return json({ok:true,message:"Assignment updated."});
  }
  if(action==="reviewer"){
   if(!manager)return fail(403,"Manager access required.");if(task.status!=="Waiting for Review")return fail(409,"Use assignment editing for a task that is not awaiting review.");checkRevision(task,data.revision);
   const employee=await taskEmployee(tx,actor,task.employee_id),reviewer=await eligibleReviewer(tx,actor,employee,str(data.reviewer,"reviewer",80));
   await run(tx,"UPDATE tasks SET reviewer_id=?,updated_at=?,revision=revision+1 WHERE id=?",reviewer,now(),task.id);await taskEvent(tx,actor,task.id,"Reviewer reassigned",reviewer);await taskNotify(tx,actor,task.id,reviewer,"Task ready for review",task.title);return json({ok:true,message:"Reviewer updated."});
  }
  if(action==="progress"){
   if(!owns)return fail(403,"Only the assigned employee may update work progress.");taskOpen(task);checkRevision(task,data.revision);
   const status=pick(data.status,activeTaskStatuses,"work status"),progress=integer(data.progress,"progress",0,100);
   if(status==="Not Started"&&progress!==0)return fail(400,"Not Started tasks must have zero progress.");
   if(status!=="In Progress")await stopTaskTimer(tx,actor,task,"Work paused");
   await run(tx,"UPDATE tasks SET status=?,progress=?,updated_at=?,revision=revision+1 WHERE id=?",status,progress,now(),task.id);await taskEvent(tx,actor,task.id,"Progress updated",`${status}; ${progress}%`);return json({ok:true,message:"Progress saved."});
  }
  if(action==="submit"){
   if(!owns)return fail(403,"Only the assigned employee may submit this work.");taskOpen(task);checkRevision(task,data.revision);
   const employee=await taskEmployee(tx,actor,actor.id);await eligibleReviewer(tx,actor,employee,task.reviewer_id??"");
   const note=str(data.note,"completion summary",1500);await stopTaskTimer(tx,actor,task,"Submitted for review");
   await run(tx,"UPDATE tasks SET status='Waiting for Review',approval_status='Pending',progress=100,submitted_at=?,reviewed_at=NULL,review_note='',updated_at=?,revision=revision+1 WHERE id=?",now(),now(),task.id);
   await run(tx,"INSERT INTO task_reviews(id,org_id,task_id,actor_id,decision,note,task_revision,created_at) VALUES(?,?,?,?,?,?,?,?)",id(),actor.org_id,task.id,actor.id,"Submitted",note,task.revision,now());await taskEvent(tx,actor,task.id,"Submitted for review",note);await taskNotify(tx,actor,task.id,task.reviewer_id!,"Task ready for review",task.title);return json({ok:true,message:"Completed work submitted for review."});
  }
  if(action==="review"){
   if(!manager||owns||(!canSuper(actor)&&task.reviewer_id!==actor.id))return fail(403,"Only the assigned reviewer or a Super Admin may review another employee's work.");
   if(task.status!=="Waiting for Review"||task.approval_status!=="Pending")return fail(409,"This task is not awaiting review.");checkRevision(task,data.revision);
   const decision=pick(data.decision,["Approved","Changes requested"] as const,"review decision"),note=str(data.note,"review note",1500,decision==="Changes requested");
   await run(tx,"UPDATE tasks SET status=?,approval_status=?,completed_at=?,reviewed_at=?,review_note=?,updated_at=?,revision=revision+1 WHERE id=?",decision==="Approved"?"Completed":"In Progress",decision,decision==="Approved"?now():null,now(),note,now(),task.id);
   await run(tx,"INSERT INTO task_reviews(id,org_id,task_id,actor_id,decision,note,task_revision,created_at) VALUES(?,?,?,?,?,?,?,?)",id(),actor.org_id,task.id,actor.id,decision,note,task.revision,now());await taskEvent(tx,actor,task.id,decision,note);await taskNotify(tx,actor,task.id,task.employee_id,decision==="Approved"?"Task approved":"Task changes requested",task.title);return json({ok:true,message:decision==="Approved"?"Task approved and completed.":"Task returned for changes."});
  }
  if(action==="cancel"||action==="reopen"){
   if(!manager)return fail(403,"An authorized manager must change task closure.");checkRevision(task,data.revision);const note=str(data.note,"reason",1500);
   if(action==="reopen"&&!['Completed','Cancelled'].includes(task.status))return fail(409,"This task is not closed.");if(action==="cancel"&&['Completed','Cancelled'].includes(task.status))return fail(409,"This task is already closed.");
   await stopTaskTimer(tx,actor,task,action==="cancel"?"Task cancelled":"Task reopened");
   await run(tx,"UPDATE tasks SET status=?,approval_status=?,completed_at=NULL,submitted_at=NULL,reviewed_at=NULL,review_note=?,updated_at=?,revision=revision+1 WHERE id=?",action==="cancel"?"Cancelled":"In Progress",action==="cancel"?"Cancelled":"Not submitted",note,now(),task.id);
   await run(tx,"INSERT INTO task_reviews(id,org_id,task_id,actor_id,decision,note,task_revision,created_at) VALUES(?,?,?,?,?,?,?,?)",id(),actor.org_id,task.id,actor.id,action==="cancel"?"Cancelled":"Reopened",note,task.revision,now());await taskEvent(tx,actor,task.id,action==="cancel"?"Cancelled":"Reopened",note);await taskNotify(tx,actor,task.id,task.employee_id,action==="cancel"?"Task cancelled":"Task reopened",task.title);return json({ok:true,message:action==="cancel"?"Task cancelled.":"Task reopened."});
  }
  if(action==="timer-start"||action==="timer-stop"){
   if(!owns)return fail(403,"Only the assigned employee may track time on this task.");taskOpen(task);
   if(action==="timer-start"){
    if(task.status==="On Hold")return fail(409,"Resume this task before starting a timer.");
    if(await one(tx,"SELECT id FROM task_time_entries WHERE employee_id=? AND kind='Timer' AND ends_at IS NULL AND voided_at IS NULL",actor.id))return fail(409,"Stop your current task timer first.");
    const logged=await one<{seconds:number}>(tx,"SELECT COALESCE(SUM(seconds),0)::int AS seconds FROM task_time_entries WHERE employee_id=? AND worked_on=? AND voided_at IS NULL",actor.id,localDate(now(),task.task_timezone));if((logged?.seconds??0)>=86400)return fail(409,"Recorded task work has reached the 24-hour daily limit.");
    await run(tx,"INSERT INTO task_time_entries(id,org_id,task_id,employee_id,kind,worked_on,starts_at,created_at,updated_at) VALUES(?,?,?,?,'Timer',?,?,?,?)",id(),actor.org_id,task.id,actor.id,localDate(now(),task.task_timezone),now(),now(),now());
    await run(tx,"UPDATE tasks SET status='In Progress',updated_at=?,revision=revision+1 WHERE id=?",now(),task.id);await taskEvent(tx,actor,task.id,"Timer started");return json({ok:true,message:"Task timer started."});
   }
   if(!await one(tx,"SELECT id FROM task_time_entries WHERE task_id=? AND employee_id=? AND kind='Timer' AND ends_at IS NULL AND voided_at IS NULL",task.id,actor.id))return fail(409,"This task has no running timer.");await stopTaskTimer(tx,actor,task,"Stopped by employee");await run(tx,"UPDATE tasks SET updated_at=?,revision=revision+1 WHERE id=?",now(),task.id);return json({ok:true,message:"Task time saved."});
  }
  if(action==="time-add"||action==="time-void"){
   if(!owns)return fail(403,"Only the assigned employee may maintain their task time logs.");taskOpen(task);
   if(action==="time-add"){
    const minutes=integer(data.minutes,"logged minutes",1,720),workedOn=date(data.workedOn,"work date")!,note=str(data.note,"work note",1000);
    const today=localDate(now(),task.task_timezone);if(workedOn>today||workedOn<new Date(Date.now()-366*86400000).toISOString().slice(0,10))return fail(400,"Choose a work date in the past year, up to today.");
    const total=await one<{seconds:number}>(tx,"SELECT COALESCE(SUM(seconds),0)::int AS seconds FROM task_time_entries WHERE employee_id=? AND worked_on=? AND voided_at IS NULL",actor.id,workedOn);
    const live=await one<{starts_at:string}>(tx,"SELECT starts_at FROM task_time_entries WHERE employee_id=? AND worked_on=? AND kind='Timer' AND ends_at IS NULL AND voided_at IS NULL",actor.id,workedOn),running=live?Math.max(0,Math.min(43200,Math.floor((Date.now()-Date.parse(live.starts_at))/1000))):0;
    if((total?.seconds??0)+running+minutes*60>86400)return fail(400,"Logged task time cannot exceed 24 hours in a day.");
    await run(tx,"INSERT INTO task_time_entries(id,org_id,task_id,employee_id,kind,worked_on,ends_at,seconds,note,created_at,updated_at) VALUES(?,?,?,?,'Manual',?,?,?,?,?,?)",id(),actor.org_id,task.id,actor.id,workedOn,now(),minutes*60,note,now(),now());await taskEvent(tx,actor,task.id,"Time logged",`${minutes} minutes on ${workedOn}; ${note}`);
   }else{
    const entry=await one<TaskTimeEntry>(tx,"SELECT * FROM task_time_entries WHERE id=? AND task_id=? AND employee_id=? AND voided_at IS NULL",str(data.entry,"time entry",80),task.id,actor.id);
    if(!entry||entry.ends_at===null)return fail(404,"Stop the timer before correcting a time entry.");const note=str(data.note,"correction reason",1000);await run(tx,"UPDATE task_time_entries SET voided_at=?,updated_at=? WHERE id=?",now(),now(),entry.id);await taskEvent(tx,actor,task.id,"Time entry voided",`${entry.id}; ${note}`);
   }
   await taskTotals(tx,task.id);await run(tx,"UPDATE tasks SET updated_at=?,revision=revision+1 WHERE id=?",now(),task.id);return json({ok:true,message:action==="time-add"?"Task time logged.":"Time entry voided; its history is retained."});
  }
  if(action==="document-link"||action==="document-unlink"){
   taskOpen(task);const documentId=action==="document-link"?str(data.document,"document",80):"";
   if(action==="document-link"){
    await requireDocumentPermission(tx,actor,await documentContext(tx,actor,documentId),"view");const employee=await one<Actor>(tx,"SELECT * FROM employees WHERE id=? AND org_id=?",task.employee_id,actor.org_id);
    if(!employee)return fail(404,"Assignee unavailable.");await requireDocumentPermission(tx,employee,await documentContext(tx,employee,documentId),"view");
    await run(tx,"INSERT INTO task_document_links(id,org_id,task_id,document_id,created_by,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(task_id,document_id) DO NOTHING",id(),actor.org_id,task.id,documentId,actor.id,now());
   }else await run(tx,"DELETE FROM task_document_links WHERE task_id=? AND id=? AND org_id=?",task.id,str(data.link,"document link",80),actor.org_id);
   await taskEvent(tx,actor,task.id,action==="document-link"?"Library document linked":"Library document unlinked",documentId);return json({ok:true,message:action==="document-link"?"Authorized document linked.":"Document unlinked."});
  }
  return fail(404,"Task action unavailable.");
 });
}

export async function taskDashboard(db:Db,actor:Actor,params=new URLSearchParams()){
 requireTasks(actor);const team=params.get("team")==="1"&&canManage(actor),scoped=team?scope(actor,"e"):{sql:"e.id=?",args:[actor.id]};
 const rows=await all<TaskItem & {employee:string;employee_no:string;department:string|null;division:string|null;project:string|null;assigner:string;reviewer:string|null;actual_seconds:number;timer_started:string|null;due_today:boolean;overdue:boolean}>(db,`SELECT t.*,e.name AS employee,e.employee_no,d.name AS department,v.name AS division,p.name AS project,a.name AS assigner,r.name AS reviewer,
 COALESCE((SELECT SUM(l.seconds) FROM task_time_entries l WHERE l.task_id=t.id AND l.voided_at IS NULL),0)::int AS actual_seconds,
 (SELECT l.starts_at FROM task_time_entries l WHERE l.task_id=t.id AND l.voided_at IS NULL AND l.ends_at IS NULL AND l.kind='Timer') AS timer_started
 FROM tasks t JOIN employees e ON e.id=t.employee_id LEFT JOIN employees a ON a.id=t.assigned_by LEFT JOIN employees r ON r.id=t.reviewer_id LEFT JOIN units d ON d.id=t.department_id LEFT JOIN units v ON v.id=t.division_id LEFT JOIN projects p ON p.id=t.project_id
 WHERE t.org_id=? AND t.release_stage=? AND t.workflow_version=1 AND ${scoped.sql} ORDER BY t.due_date ASC NULLS LAST,t.created_at DESC,t.id`,actor.org_id,taskDataset(),...scoped.args);
 const mapped=rows.map(row=>{const today=localDate(now(),row.task_timezone),open=!['Completed','Cancelled'].includes(row.status),until=new Date(today+"T12:00:00Z");until.setUTCDate(until.getUTCDate()+7);return {...row,
  actual_seconds:row.actual_seconds+(row.timer_started?Math.max(0,Math.min(43200,Math.floor((Date.now()-Date.parse(row.timer_started))/1000))):0),
  overdue:!!(open&&row.due_date&&row.due_date<today),due_today:!!(open&&(row.due_date===today||row.start_date===today||localDate(row.created_at,row.task_timezone)===today)),upcoming:!!(open&&row.due_date&&row.due_date>today&&row.due_date<=until.toISOString().slice(0,10))};});
 const stats={today:mapped.filter(t=>t.due_today).length,overdue:mapped.filter(t=>t.overdue).length,upcoming:mapped.filter(t=>t.upcoming).length,completed:mapped.filter(t=>t.status==='Completed').length,pending:mapped.filter(t=>t.approval_status==='Pending').length,open:mapped.filter(t=>!['Completed','Cancelled'].includes(t.status)).length,
  estimatedSeconds:mapped.filter(t=>t.status!=='Cancelled').reduce((sum,t)=>sum+t.estimate_minutes*60,0),actualSeconds:mapped.reduce((sum,t)=>sum+t.actual_seconds,0)};
 const q=(params.get('q')??'').trim().toLowerCase().slice(0,100),bucket=params.get('bucket')??'all',status=params.get('status')??'',employee=params.get('employee')??'',priority=params.get('priority')??'';
 const filtered=mapped.filter(row=>(!q||`${row.title} ${row.description} ${row.employee} ${row.project??''} ${row.client_reference}`.toLowerCase().includes(q))&&(!status||row.status===status)&&(!priority||row.priority===priority)&&(!employee||team&&row.employee_id===employee)&&
 (bucket==='today'?row.due_today:bucket==='overdue'?row.overdue:bucket==='upcoming'?row.upcoming:bucket==='completed'?row.status==='Completed':bucket==='pending'?row.approval_status==='Pending':true));
 const pageSize=30,pages=Math.max(1,Math.ceil(filtered.length/pageSize)),page=Math.min(pages,Math.max(1,Math.floor(Number(params.get('page'))||1)));
 const people=canManage(actor)?await all(db,`SELECT e.id,e.name,e.role,e.department_id,e.division_id,e.manager_id,d.name AS department,v.name AS division FROM employees e LEFT JOIN units d ON d.id=e.department_id LEFT JOIN units v ON v.id=e.division_id WHERE e.org_id=? AND e.status='Active' AND e.employment_status<>'Ended' AND e.role<>'guest' AND ${scope(actor,'e').sql} ORDER BY e.name`,actor.org_id,...scope(actor,'e').args):[];
 const reviewers=canManage(actor)?await all(db,"SELECT id,name,role,department_id,division_id,manager_id FROM employees WHERE org_id=? AND status='Active' AND employment_status<>'Ended' AND role IN('super_admin','admin','manager','hr') ORDER BY name",actor.org_id):[];
 const projects=canManage(actor)?await all(db,`SELECT p.id,p.name FROM projects p WHERE p.org_id=? AND p.status='Active' AND (?=1 OR p.owner_id=? OR p.department_id=? OR EXISTS(SELECT 1 FROM tasks t WHERE t.project_id=p.id AND t.employee_id=? AND t.release_stage=?)) ORDER BY p.name`,actor.org_id,canSuper(actor)?1:0,actor.id,actor.department_id,actor.id,taskDataset()):[];
 const running=await one(db,`SELECT l.id,l.task_id,l.starts_at,t.title FROM task_time_entries l JOIN tasks t ON t.id=l.task_id WHERE l.employee_id=? AND l.org_id=? AND t.release_stage=? AND l.kind='Timer' AND l.ends_at IS NULL AND l.voided_at IS NULL`,actor.id,actor.org_id,taskDataset());
 const teamRows=team?people.map(person=>{const tasks=mapped.filter(t=>t.employee_id===person.id),planned=tasks.filter(t=>t.status!=='Cancelled');return {...person,open:tasks.filter(t=>!['Completed','Cancelled'].includes(t.status)).length,overdue:tasks.filter(t=>t.overdue).length,pending:tasks.filter(t=>t.approval_status==='Pending').length,completed:tasks.filter(t=>t.status==='Completed').length,estimatedSeconds:planned.reduce((n,t)=>n+t.estimate_minutes*60,0),actualSeconds:tasks.reduce((n,t)=>n+t.actual_seconds,0),progress:planned.length?Math.round(planned.reduce((n,t)=>n+t.progress,0)/planned.length):0};}):[];
 return json({managedTasks:true,rows:filtered.slice((page-1)*pageSize,page*pageSize),stats,team,manager:canManage(actor),staff:people,reviewers,projects,teamRows,running,serverTime:now(),today:localDate(now(),actor.time_zone),registry:{page,pages,total:filtered.length},query:{q,bucket,status,priority,employee}});
}
export async function taskDetail(db:Db,actor:Actor,target:string,commentPage=1){
 const task=await taskFor(db,actor,target),[people,notes,time,files,links,reviews,events]=await Promise.all([
  one(db,`SELECT e.name AS employee,e.employee_no,a.name AS assigner,r.name AS reviewer,d.name AS department,v.name AS division,p.name AS project FROM employees e LEFT JOIN employees a ON a.id=? LEFT JOIN employees r ON r.id=? LEFT JOIN units d ON d.id=? LEFT JOIN units v ON v.id=? LEFT JOIN projects p ON p.id=? WHERE e.id=?`,task.assigned_by,task.reviewer_id,task.department_id,task.division_id,task.project_id,task.employee_id),
  all(db,"SELECT n.id,n.body,n.created_at,e.name AS author FROM task_notes n JOIN employees e ON e.id=n.author_id WHERE n.task_id=? ORDER BY n.created_at DESC,n.id DESC LIMIT 51 OFFSET ?",target,(Math.min(10000,Math.max(1,Math.floor(commentPage)))-1)*50),
  all(db,"SELECT l.*,e.name AS employee FROM task_time_entries l JOIN employees e ON e.id=l.employee_id WHERE l.task_id=? ORDER BY l.created_at DESC LIMIT 500",target),
  all(db,"SELECT f.id,f.filename,f.mime,f.bytes,f.page_count,f.created_at,f.uploaded_by,e.name AS uploader FROM task_files f JOIN employees e ON e.id=f.uploaded_by WHERE f.task_id=? AND f.deleted_at IS NULL ORDER BY f.created_at DESC",target),
  all<{id:string;document_id:string}>(db,"SELECT id,document_id FROM task_document_links WHERE task_id=? ORDER BY created_at",target),
  all(db,"SELECT r.id,r.decision,r.note,r.created_at,r.task_revision,e.name AS actor FROM task_reviews r JOIN employees e ON e.id=r.actor_id WHERE r.task_id=? ORDER BY r.created_at DESC",target),
  all(db,"SELECT a.id,a.action,a.detail,a.created_at,e.name AS actor FROM task_events a LEFT JOIN employees e ON e.id=a.actor_id WHERE a.task_id=? ORDER BY a.created_at DESC,a.id DESC LIMIT 200",target)
 ]);
 const documents=[];for(const link of links){try{const context=await documentContext(db,actor,link.document_id);if(await documentMask(db,actor,context)&permissionBit('view'))documents.push({id:link.id,documentId:link.document_id,name:context.document!.name,available:true});else documents.push({id:link.id,available:false});}catch{documents.push({id:link.id,available:false});}}
 const actual=await one<{seconds:number}>(db,"SELECT COALESCE(SUM(seconds),0)::int AS seconds FROM task_time_entries WHERE task_id=? AND voided_at IS NULL",target);
 return json({row:{...task,...people},notes:notes.slice(0,50),moreComments:notes.length>50,commentPage,time,files,documents,reviews,events,actualSeconds:actual?.seconds??0,owns:task.employee_id===actor.id,manager:canManage(actor),canReview:canManage(actor)&&task.employee_id!==actor.id&&(canSuper(actor)||task.reviewer_id===actor.id),serverTime:now()});
}
