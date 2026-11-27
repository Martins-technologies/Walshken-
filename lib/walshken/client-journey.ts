import {assertClientCaseUnheld, canAdministerCase, clientCaseFor, notifyCaseStaff, recordCaseEvent, staffCaseFor, type ClientCase} from "./client-cases";
import {notifyClient} from "./client-notifications";
import {clientProfileSnapshot} from "./client-profile";
import type {ClientActor} from "./customer";
import {all,audit,canSuper,country,date,decryptSettings,encryptSettings,fail,id,integer,now,one,orgId,pick,run,str,type Actor,type Db} from "./server";

const milestoneStates = ["Upcoming","In progress","Complete"] as const;
const taskStates = ["Open","In progress","Completed","Cancelled"] as const;
const taskKinds = ["confirmation","profile","documents","agreements","payments","appointments"] as const;
const relationships = ["Spouse","Partner","Child","Parent","Other dependant"] as const;
type Staff = {kind:"staff";actor:Actor};
type Account = {kind:"client";actor:ClientActor};
type Viewer = Staff | Account;
type Stage = {id:string;title:string;description:string;position:number;enabled:boolean;revision:number};
type Task = {id:string;case_id:string;reference?:string;title:string;details:string;due_on:string|null;action_kind:typeof taskKinds[number];status:typeof taskStates[number];completed_at:string|null;revision:number};
type FamilyDetails = {name:string;relationship:typeof relationships[number];birthDate:string;passport:string;passportCountry:string;passportExpiry:string};
type FamilyRecord = {id:string;revision:number;encrypted_details:string;updated_at:string};
type DocumentLink = {id:string;category:string;filename:string;dependant_id?:string};
type NextAction = {id:string;caseId?:string;reference?:string;title:string;details:string;dueOn?:string|null;kind:typeof taskKinds[number];revision?:number;status?:string};

async function visibleCase(db:Db,viewer:Viewer,caseId:string,lock=false){
  return viewer.kind==="staff" ? staffCaseFor(db,viewer.actor,caseId,lock) : clientCaseFor(db,viewer.actor.id,caseId,lock);
}
const caseArgs=(entry:ClientCase)=>[entry.org_id,entry.id,entry.customer_id] as const;
const owner=(viewer:Viewer)=>viewer.kind==="staff"?{employeeId:viewer.actor.id}:{customerId:viewer.actor.id};
const casePath=(row:ClientCase)=>"/customer/cases?case="+encodeURIComponent(row.id);
async function notice(db:Db,row:ClientCase,title:string,body:string,key:string){
  await notifyClient(db,row.customer_id,{type:"case",title,body,href:casePath(row),dedupeKey:"journey:"+key});
}
async function familyEvent(db:Db,row:ClientCase,viewer:Viewer,event:string,target:string){
  await recordCaseEvent(db,row,event,owner(viewer));
  if(viewer.kind==="staff")await audit(db,viewer.actor,event,"client dependant",target).run();
}
async function taskRows(db:Db,row:ClientCase){
  return all<Task>(db,`SELECT id,case_id,title,details,due_on::text AS due_on,action_kind,status,completed_at,revision
    FROM client_action_tasks WHERE org_id=? AND case_id=? AND customer_id=?
    ORDER BY CASE WHEN status IN('Open','In progress') THEN 0 ELSE 1 END,due_on NULLS LAST,updated_at DESC,id LIMIT 200`,...caseArgs(row));
}
async function visibleMilestones(db:Db,row:ClientCase){
  return all(db,`SELECT id,stage_title,state,details,next_action,event_on::text AS event_on,decided_at
    FROM (SELECT DISTINCT ON(workflow_stage_id) id,stage_title,state,details,next_action,event_on,decided_at,stage_position
      FROM client_case_milestones WHERE org_id=? AND case_id=? AND customer_id=? AND decision='Published'
      ORDER BY workflow_stage_id,decided_at DESC,id DESC) published
    ORDER BY stage_position,decided_at,id LIMIT 100`,...caseArgs(row));
}
async function decodeFamily(record:FamilyRecord):Promise<FamilyDetails>{
  const value=await decryptSettings("client-dependant:"+record.id,record.encrypted_details);
  return JSON.parse(value.details) as FamilyDetails;
}
async function getFamilyRecord(db:Db,row:ClientCase,target:string){
  const item=await one<FamilyRecord>(db,`SELECT id,revision,encrypted_details,updated_at FROM client_dependants
    WHERE org_id=? AND case_id=? AND customer_id=? AND id=? AND archived_at IS NULL`,...caseArgs(row),target);
  if(!item)return fail(404,"This family member is unavailable.");
  return item;
}
async function familyList(db:Db,row:ClientCase){
  const [rows,documents,links]=await Promise.all([
    all<FamilyRecord>(db,`SELECT id,revision,encrypted_details,updated_at FROM client_dependants
      WHERE org_id=? AND case_id=? AND customer_id=? AND archived_at IS NULL ORDER BY created_at,id LIMIT 40`,...caseArgs(row)),
    all<DocumentLink>(db,`SELECT d.id,d.category,latest.filename FROM client_documents d
      JOIN LATERAL(SELECT filename FROM client_document_versions WHERE document_id=d.id ORDER BY version DESC LIMIT 1) latest ON true
      WHERE d.org_id=? AND d.case_id=? AND d.customer_id=? AND d.deleted_at IS NULL ORDER BY d.created_at DESC,d.id LIMIT 250`,...caseArgs(row)),
    all<{dependant_id:string;document_id:string}>(db,`SELECT dependant_id,document_id FROM client_dependant_documents
      WHERE org_id=? AND case_id=? AND customer_id=? AND unlinked_at IS NULL ORDER BY linked_at`,...caseArgs(row)),
  ]);
  const docs=new Map(documents.map(doc=>[doc.id,doc]));
  return {availableDocuments:documents,dependants:await Promise.all(rows.map(async record=>{
    const person=await decodeFamily(record);
    return {id:record.id,revision:record.revision,updatedAt:record.updated_at,name:person.name,relationship:person.relationship,
      hasPassport:Boolean(person.passport),documents:links.filter(link=>link.dependant_id===record.id).flatMap(link=>docs.get(link.document_id)??[])};
  }))};
}
export async function exportClientJourney(db:Db,customerId:string,caseId:string){
  const row=await clientCaseFor(db,customerId,caseId);
  const [rows,milestones,actionTasks,supportingDocuments]=await Promise.all([
    all<FamilyRecord & {archived_at:string|null}>(db,`SELECT id,revision,encrypted_details,updated_at,archived_at FROM client_dependants
      WHERE org_id=? AND case_id=? AND customer_id=? ORDER BY created_at,id LIMIT 201`,...caseArgs(row)),
    all(db,`SELECT id,stage_title,state,details,next_action,event_on::text AS event_on,decided_at FROM client_case_milestones
      WHERE org_id=? AND case_id=? AND customer_id=? AND decision='Published' ORDER BY decided_at,id LIMIT 501`,...caseArgs(row)),
    all(db,`SELECT id,title,details,due_on::text AS due_on,action_kind,status,completed_at,updated_at FROM client_action_tasks
      WHERE org_id=? AND case_id=? AND customer_id=? ORDER BY created_at,id LIMIT 501`,...caseArgs(row)),
    all(db,`SELECT dependant_id,document_id,linked_at,unlinked_at FROM client_dependant_documents
      WHERE org_id=? AND case_id=? AND customer_id=? ORDER BY linked_at,dependant_id,document_id LIMIT 501`,...caseArgs(row)),
  ]);
  if(rows.length>200||[milestones,actionTasks,supportingDocuments].some(records=>records.length>500)){
    return fail(409,"Ask the privacy team to prepare an expanded case journey export.");
  }
  const dependants=await Promise.all(rows.map(async item=>({id:item.id,details:await decodeFamily(item),updated_at:item.updated_at,archived_at:item.archived_at})));
  return {dependants,milestones,actionTasks,supportingDocuments};
}
async function nextActions(db:Db,account:ClientActor,caseId:string):Promise<NextAction[]>{
  type Input = {id:string;case_id:string;reference?:string;title:string;details?:string;due_on?:string|null};
  const activeFilter=" AND (?='' OR c.id=?) ";
  const args=[orgId,account.id,caseId,caseId];
  const [profile,manual,requests,invoices,agreements]=await Promise.all([
    clientProfileSnapshot(db,account),
    all<Task>(db,`SELECT t.id,t.case_id,c.reference,t.title,t.details,t.due_on::text AS due_on,t.action_kind,t.status,t.revision
      FROM client_action_tasks t JOIN client_cases c ON c.id=t.case_id AND c.org_id=t.org_id
      WHERE t.org_id=? AND t.customer_id=? ${activeFilter} AND t.status IN('Open','In progress')
      ORDER BY t.due_on NULLS LAST,t.updated_at DESC,t.id LIMIT 150`,...args),
    all<Input>(db,`SELECT r.id,r.case_id,c.reference,r.title,r.instructions AS details,r.due_on::text AS due_on
      FROM client_case_document_requests r JOIN client_cases c ON c.id=r.case_id AND c.org_id=r.org_id
      WHERE c.org_id=? AND c.customer_id=? ${activeFilter} AND r.status IN('Open','Replacement requested') AND c.client_status<>'Closed'
      ORDER BY r.due_on NULLS LAST,r.id LIMIT 150`,...args),
    all<Input>(db,`SELECT i.id,i.case_id,c.reference,'Pay invoice '||i.invoice_number AS title,i.due_on
      FROM client_invoices i JOIN client_cases c ON c.id=i.case_id AND c.org_id=i.org_id
      WHERE c.org_id=? AND c.customer_id=? ${activeFilter} AND i.status IN ('Open','Partially paid')
      ORDER BY i.due_on NULLS LAST,i.id LIMIT 150`,...args),
    all<Input>(db,`SELECT v.id,a.case_id,c.reference,v.title FROM client_agreements a
      JOIN client_cases c ON c.id=a.case_id AND c.org_id=a.org_id
      JOIN LATERAL(SELECT id,title,published_at,withdrawn_at FROM client_agreement_versions WHERE agreement_id=a.id
        AND published_at IS NOT NULL ORDER BY version DESC LIMIT 1) v ON true
      WHERE c.org_id=? AND c.customer_id=? ${activeFilter} AND v.withdrawn_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM client_agreement_responses r WHERE r.version_id=v.id)
      ORDER BY v.published_at DESC,v.id LIMIT 150`,...args),
  ]);
  const from=(item:Input,kind:NextAction["kind"],title:string):NextAction=>({id:item.id,caseId:item.case_id,reference:item.reference,title,details:item.details??"",dueOn:item.due_on,kind});
  const actions=[
    ...manual.map(item=>({...from(item,item.action_kind,item.title),revision:item.revision,status:item.status})),
    ...requests.map(item=>from(item,"documents",item.title)),
    ...invoices.map(item=>from(item,"payments",item.title)),
    ...agreements.map(item=>from(item,"agreements","Review and sign "+item.title)),
  ];
  if(profile.completion<100){
    actions.push({id:"profile",kind:"profile",title:"Complete your profile",details:"Add the remaining details in My profile."});
  }
  return actions.sort((a,b)=>(a.dueOn??"9999-12-31").localeCompare(b.dueOn??"9999-12-31")||a.title.localeCompare(b.title)).slice(0,100);
}
export async function clientJourneyView(db:Db,actor:ClientActor,caseId:string,overview:boolean){
  const row=caseId?await visibleCase(db,{kind:"client",actor},caseId):null;
  const [actions,milestones,family]=await Promise.all([
    nextActions(db,actor,overview?"":caseId),
    row?visibleMilestones(db,row):[],
    row&&!overview?familyList(db,row):null,
  ]);
  return {actions,milestones,family};
}
export async function staffJourneyView(db:Db,actor:Actor,caseId:string){
  const row=await visibleCase(db,{kind:"staff",actor},caseId);
  const [milestones,tasks,family,stages,canReview]=await Promise.all([
    all(db,`SELECT id,stage_title,state,details,next_action,event_on::text AS event_on,decision,review_note,submitted_by,submitted_at,decided_at
      FROM client_case_milestones WHERE org_id=? AND case_id=? AND customer_id=? ORDER BY submitted_at DESC,id DESC LIMIT 100`,...caseArgs(row)),
    taskRows(db,row),familyList(db,row),
    all<Stage>(db,"SELECT id,title,description,position,enabled,revision FROM client_workflow_stages WHERE org_id=? ORDER BY position,id LIMIT 100",row.org_id),
    canAdministerCase(db,actor,row),
  ]);
  return {milestones,tasks,family,stages,canReview,canConfigure:canSuper(actor),staffId:actor.id};
}
export async function familyPrivateDetails(db:Db,viewer:Viewer,caseId:string,target:string){
  return db.transaction(async tx=>{
    const row=await visibleCase(tx,viewer,caseId,true),record=await getFamilyRecord(tx,row,target);
    const result=await decodeFamily(record);
    await familyEvent(tx,row,viewer,"Private family details viewed",target);
    return {id:record.id,revision:record.revision,details:result};
  });
}

async function staffMilestone(db:Db,actor:Actor,row:ClientCase,action:string,data:Record<string,unknown>){
  if(action==="milestone-submit"){
    const stageId=str(data.stage,"workflow stage",140);
    const stage=await one<Stage>(db,`SELECT id,title,position FROM client_workflow_stages
      WHERE id=? AND org_id=? AND enabled FOR SHARE`,stageId,row.org_id);
    if(!stage)return fail(404,"This workflow stage is unavailable.");
    const state=pick(data.state,milestoneStates,"milestone status"),key=id();
    const eventOn=date(data.eventOn,"milestone date",state==="Complete");
    if(state==="Complete"&&eventOn&&eventOn>now().slice(0,10))return fail(400,"Completed milestones cannot have future dates.");
    await run(db,`INSERT INTO client_case_milestones(id,org_id,case_id,customer_id,workflow_stage_id,stage_title,stage_position,
      state,details,next_action,event_on,submitted_by,submitted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,key,...caseArgs(row),
      stage.id,stage.title,stage.position,state,str(data.details,"milestone description",2000),str(data.nextAction,"next action",500,false),eventOn,actor.id,now());
    await recordCaseEvent(db,row,"Client milestone submitted for review",{employeeId:actor.id});
    return {id:key,message:"Milestone submitted for another reviewer."};
  }
  if(!await canAdministerCase(db,actor,row))return fail(403,"An authorized case administrator must decide on this milestone.");
  const target=str(data.milestone,"milestone",80),decision=pick(data.decision,["Published","Returned"] as const,"milestone decision");
  const pending=await one<{submitted_by:string;decision:string}>(db,`SELECT submitted_by,decision FROM client_case_milestones
    WHERE org_id=? AND case_id=? AND customer_id=? AND id=? FOR UPDATE`,...caseArgs(row),target);
  if(!pending)return fail(404,"This milestone is unavailable.");
  if(pending.decision!=="Pending")return fail(409,"This milestone has already been reviewed.");
  if(pending.submitted_by===actor.id)return fail(403,"Another authorized administrator must approve your milestone.");
  await run(db,"UPDATE client_case_milestones SET decision=?,decided_at=?,decided_by=?,review_note=? WHERE id=?",
    decision,now(),actor.id,str(data.note,"review note",500,decision==="Returned"),target);
  if(decision==="Published"){
    await notice(db,row,"Case milestone published","Open your case to see the approved milestone and next action.",target);
  }
  await recordCaseEvent(db,row,decision==="Published"?"Client milestone published":"Client milestone returned",{employeeId:actor.id});
  return {message:decision==="Published"?"Milestone published.":"Milestone returned to staff."};
}
async function updateStage(db:Db,actor:Actor,action:string,data:Record<string,unknown>){
  if(!canSuper(actor))return fail(403,"Only a Super Admin can configure workflow stages.");
  const title=str(data.title,"stage name",100),description=str(data.description,"stage description",500,false);
  const position=integer(data.position,"stage position",1,9999);
  if(typeof data.enabled!=="boolean")return fail(400,"Choose whether the stage is available.");
  if(action==="stage-create"){
    const count=await one<{total:number}>(db,"SELECT COUNT(*)::int AS total FROM client_workflow_stages WHERE org_id=?",actor.org_id);
    if((count?.total??0)>=100)return fail(409,"This workspace has reached its workflow stage limit.");
    const key=id();
    await run(db,"INSERT INTO client_workflow_stages(id,org_id,title,description,position,enabled) VALUES(?,?,?,?,?,?)",
      key,actor.org_id,title,description,position,data.enabled);
    await audit(db,actor,"Client workflow stage created","client workflow stage",key).run();
    return {id:key,message:"Workflow stage created."};
  }
  const key=str(data.stage,"stage",140),revision=integer(data.revision,"stage revision",1,2147483646);
  const result=await run(db,`UPDATE client_workflow_stages SET title=?,description=?,position=?,enabled=?,revision=revision+1
    WHERE org_id=? AND id=? AND revision=?`,title,description,position,data.enabled,actor.org_id,key,revision);
  if(!result.count)return fail(409,"Workflow stage changed. Refresh before editing.");
  await audit(db,actor,"Client workflow stage updated","client workflow stage",key).run();
  return {message:"Workflow stage saved."};
}
async function staffTask(db:Db,actor:Actor,row:ClientCase,action:string,data:Record<string,unknown>){
  const title=str(data.title,"task title",140),details=str(data.details,"task details",1500,false),dueOn=date(data.dueOn,"due date",false);
  const kind=pick(data.kind,taskKinds,"task action"),status=pick(data.status,taskStates,"task status"),stamp=now();
  if(action==="task-create"){
    const key=id();
    await run(db,`INSERT INTO client_action_tasks(id,org_id,case_id,customer_id,title,details,due_on,action_kind,status,assigned_by,
      created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,key,...caseArgs(row),title,details,dueOn,kind,status,actor.id,stamp,stamp,
      status==="Completed"?stamp:null);
    if(status==="Open"||status==="In progress"){
      await notice(db,row,"A case task was assigned","Open Your Next Steps to review this case task.",key);
    }
    await recordCaseEvent(db,row,"Client case task assigned",{employeeId:actor.id});
    return {id:key,message:"Client task assigned."};
  }
  const target=str(data.task,"task",80),revision=integer(data.revision,"task revision",1,2147483646);
  const changed=await run(db,`UPDATE client_action_tasks SET title=?,details=?,due_on=?,action_kind=?,status=?,updated_at=?,
      completed_at=CASE WHEN ?='Completed' THEN COALESCE(completed_at,?) ELSE NULL END,revision=revision+1
    WHERE id=? AND org_id=? AND case_id=? AND customer_id=? AND revision=?`,title,details,dueOn,kind,status,stamp,status,stamp,target,...caseArgs(row),revision);
  if(!changed.count)return fail(409,"This task changed or is unavailable. Refresh before editing.");
  await recordCaseEvent(db,row,status==="Completed"?"Client case task completed":"Client case task updated",{employeeId:actor.id});
  return {message:"Client task updated."};
}

async function completeTask(db:Db,row:ClientCase,viewer:Account,data:Record<string,unknown>){
  const target=str(data.task,"task",80),revision=integer(data.revision,"task revision",1,2147483646),stamp=now();
  const changed=await run(db,`UPDATE client_action_tasks SET status='Completed',completed_at=?,updated_at=?,revision=revision+1
    WHERE org_id=? AND case_id=? AND customer_id=? AND id=? AND revision=? AND action_kind='confirmation' AND status IN ('Open','In progress')`,
    stamp,stamp,...caseArgs(row),target,revision);
  if(!changed.count)return fail(409,"Only an open confirmation task can be marked complete here. Refresh and try again.");
  await recordCaseEvent(db,row,"Client marked a case task complete",owner(viewer));
  await notifyCaseStaff(db,row,"Client task completed","Open the case to review the completed task.","journey-task:"+target+":"+revision);
  return {message:"Task marked complete."};
}
async function familyAction(db:Db,viewer:Viewer,row:ClientCase,action:string,data:Record<string,unknown>){
  await assertClientCaseUnheld(db,row.id,row.customer_id);
  if(action==="family-add"||action==="family-edit"){
    const key=action==="family-add"?id():str(data.dependant,"family member",80);
    const record=action==="family-edit"?await getFamilyRecord(db,row,key):null;
    const name=str(data.name,"full legal name",120),relationship=pick(data.relationship,relationships,"relationship");
    const birthDate=date(data.birthDate,"birth date")!;
    if(birthDate>now().slice(0,10)||birthDate<"1900-01-01")return fail(400,"Choose a valid birth date.");
    const passport=str(data.passport,"passport number",30,false);
    if(passport&&!/^[A-Za-z0-9 -]{3,30}$/.test(passport))return fail(400,"Enter a valid passport number.");
    const passportCountry=data.passportCountry?country(data.passportCountry):"";
    const passportExpiry=date(data.passportExpiry,"passport expiry",false)??"";
    if(passport&&!passportCountry)return fail(400,"Choose the passport's issuing country.");
    if(passportExpiry&&passportExpiry<birthDate)return fail(400,"Passport expiry cannot be earlier than the birth date.");
    if(!passport&&(passportCountry||passportExpiry))return fail(400,"Enter a passport number before entering its issuing country or expiry.");
    const encrypted=await encryptSettings("client-dependant:"+key,{details:JSON.stringify({name,relationship,birthDate,passport,passportCountry,passportExpiry} satisfies FamilyDetails)});
    const stamp=now();
    if(record){
      const revision=integer(data.revision,"family revision",1,2147483646);
      const change=await run(db,`UPDATE client_dependants SET encrypted_details=?,updated_at=?,revision=revision+1
        WHERE id=? AND org_id=? AND case_id=? AND customer_id=? AND revision=? AND archived_at IS NULL`,encrypted,stamp,key,...caseArgs(row),revision);
      if(!change.count)return fail(409,"This family member was updated. Refresh before editing.");
    } else {
      const count=await one<{total:number}>(db,"SELECT COUNT(*)::int AS total FROM client_dependants WHERE case_id=? AND archived_at IS NULL",row.id);
      if((count?.total??0)>=40)return fail(409,"This case already has 40 active family members.");
      await run(db,`INSERT INTO client_dependants(id,org_id,case_id,customer_id,encrypted_details,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)`,key,...caseArgs(row),encrypted,stamp,stamp);
    }
    await familyEvent(db,row,viewer,record?"Client dependant details updated":"Client dependant added",key);
    return {id:key,message:record?"Family details saved.":"Family member added."};
  }
  const target=str(data.dependant,"family member",80);
  await getFamilyRecord(db,row,target);
  if(action==="family-archive"){
    const revision=integer(data.revision,"family revision",1,2147483646),stamp=now();
    const changed=await run(db,`UPDATE client_dependants SET archived_at=?,updated_at=?,revision=revision+1
      WHERE id=? AND org_id=? AND case_id=? AND customer_id=? AND revision=? AND archived_at IS NULL`,stamp,stamp,target,...caseArgs(row),revision);
    if(!changed.count)return fail(409,"This family member changed. Refresh before archiving.");
    await familyEvent(db,row,viewer,"Client dependant archived",target);
    return {message:"Family member archived. Original case records were retained."};
  }
  const document=str(data.document,"supporting document",80);
  if(!await one(db,`SELECT id FROM client_documents WHERE org_id=? AND case_id=? AND customer_id=? AND id=? AND deleted_at IS NULL`,...caseArgs(row),document)){
    return fail(404,"This supporting document is unavailable in this case.");
  }
  const stamp=now();
  const result=action==="family-link"
    ?await run(db,`INSERT INTO client_dependant_documents(dependant_id,document_id,org_id,case_id,customer_id,linked_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(dependant_id,document_id) DO UPDATE SET linked_at=excluded.linked_at,unlinked_at=NULL
        WHERE client_dependant_documents.unlinked_at IS NOT NULL`,target,document,...caseArgs(row),stamp)
    :await run(db,`UPDATE client_dependant_documents SET unlinked_at=?
        WHERE dependant_id=? AND document_id=? AND org_id=? AND case_id=? AND customer_id=? AND unlinked_at IS NULL`,stamp,target,document,...caseArgs(row));
  if(result.count){
    await familyEvent(db,row,viewer,action==="family-link"?"Client dependant document linked":"Client dependant document unlinked",target);
  }
  return {message:action==="family-link"?"Supporting document linked.":"Supporting document removed from this family member."};
}
export async function mutateClientJourney(db:Db,viewer:Viewer,action:string,data:Record<string,unknown>){
  return db.transaction(async tx=>{
    const row=await visibleCase(tx,viewer,str(data.case,"case",80),true);
    if(["family-add","family-edit","family-archive","family-link","family-unlink"].includes(action)){
      return familyAction(tx,viewer,row,action,data);
    }
    if(viewer.kind==="client"){
      if(action==="task-complete")return completeTask(tx,row,viewer,data);
      return fail(403,"This action requires case staff.");
    }
    if(action==="stage-create"||action==="stage-edit")return updateStage(tx,viewer.actor,action,data);
    if(action==="milestone-submit"||action==="milestone-review")return staffMilestone(tx,viewer.actor,row,action,data);
    if(action==="task-create"||action==="task-edit")return staffTask(tx,viewer.actor,row,action,data);
    return fail(404,"This case action is unavailable.");
  });
}
