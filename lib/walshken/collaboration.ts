import { authorizedDirectReply, checkDirect, communicationAccess, communicationGovernanceEnabled, communicationGroupPeople, communicationPeople,
  directPeer, eligibleGroupPeer, inCommunicationDepartment, existingDirect, mustConfirmCrossDepartment } from "./communication-access";
import { communicationContent, communicationOversight, communicationSupport, communicationVisibility } from "./communication-management";
import { documentEvaluation } from "./document-access";
import { attachableDocuments, messageDocumentName, messageDocumentsEnabled, shareMessageDocument } from "./message-documents";
import { messageReactions } from "./catalog";
import {
  all, audit, canManage, canSuper, colleague, country, datetime, fail, id, json, notify, now, one,
  pick, requireStaff, run, stmt, str, throttle, type Actor, type Db, type Row,
} from "./server";

function memberIds(value:unknown, max=100) {
  if(!Array.isArray(value)||value.length>max) return fail(400,"Choose permitted participants.");
  return [...new Set(value.map((item)=>str(item,"participant",80)))];
}
type CommunicationPolicy = {
  group_creation: string; group_approval: number; member_management: string;
  message_forwarding: string; message_retention_days: number; external_messaging: number; message_changes: string;
};
export const communicationAdmin = (actor: Actor) => actor.role==="super_admin"||actor.role==="admin";
type ChannelScope = { kind: string; department_id: string | null; project_id: string | null; country: string | null; closes_at: string | null };
const conversationKinds = ["Direct","Group","Department","Project","Company","Country","Temporary","Private","External"] as const;
export async function communicationPolicy(db: Db, actor: Actor) {
  const policy = await one<CommunicationPolicy>(db, `SELECT group_creation,group_approval,member_management,message_forwarding,
    message_retention_days,external_messaging,message_changes FROM organizations WHERE id=?`, actor.org_id);
  if (!policy) return fail(404, "Workspace policy is unavailable.");
  return policy;
}
export const canCreateGroups = (actor: Actor, policy: CommunicationPolicy) => communicationAdmin(actor)
  || actor.role !== "guest" && (policy.group_creation === "All staff" || (policy.group_creation === "Managers" && canManage(actor)));
export const canForwardMessages = (actor: Actor, policy: CommunicationPolicy) => actor.role !== "guest"
  && (policy.message_forwarding === "All staff" || (policy.message_forwarding === "Managers" && canManage(actor)));
export const canManageGroupMembers = (actor: Actor, owner: string, policy: CommunicationPolicy) =>
  communicationAdmin(actor) || actor.role !== "guest" && ((policy.member_management !== "Super Admin" && owner === actor.id) || policy.member_management === "Members");

export function retentionCutoff(days: number) {
  return days ? new Date(Date.now() - days * 86_400_000).toISOString() : "";
}

function activeChannels(actor: Actor, policy: CommunicationPolicy) {
  const additionalDepartments = communicationGovernanceEnabled() && actor.role !== "guest";
  return {sql:`c.status='Active' AND (c.closes_at IS NULL OR c.closes_at>?)
    AND (?=1 OR c.kind<>'External') AND (?=0 OR c.kind='External')
    AND (c.kind<>'Private' OR ?=1)
    AND ((?=1 AND c.created_by=?) OR (
      (c.department_id IS NULL OR c.department_id=?${additionalDepartments ? ` OR EXISTS(SELECT 1 FROM staff_unit_memberships r
        WHERE r.org_id=c.org_id AND r.employee_id=? AND r.unit_id=c.department_id)` : ""})
      AND (c.country IS NULL OR c.country=?)
      AND (c.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=c.project_id AND p.org_id=c.org_id
        AND (p.owner_id=? OR p.department_id=? OR EXISTS (SELECT 1 FROM tasks t WHERE t.project_id=p.id AND t.employee_id=?))))
    ))`,
    args:[now(),policy.external_messaging,actor.role==="guest"?1:0,canManage(actor)?1:0,canSuper(actor)?1:0,actor.id,
      actor.department_id,...(additionalDepartments?[actor.id]:[]),actor.country,actor.id,actor.department_id,actor.id]};
}
export async function calendarTeams(db: Db, actor: Actor) {
  const filter = activeChannels(actor, await communicationPolicy(db, actor));
  return all<{ id: string; name: string; members: string[] }>(db, `SELECT c.id,c.title AS name,
    ARRAY(SELECT m.employee_id FROM conversation_members m WHERE m.conversation_id=c.id) AS members
    FROM conversations c JOIN conversation_members mine ON mine.conversation_id=c.id AND mine.employee_id=?
    WHERE c.org_id=? AND c.kind NOT IN('Direct','External') AND ${filter.sql} ORDER BY c.title,c.id`, actor.id, actor.org_id, ...filter.args);
}

async function channel(db:Db, actor:Actor, target:string, policy:CommunicationPolicy) {
  const filter=activeChannels(actor,policy);
  const row=await one<ChannelScope & {id:string;created_by:string;title:string}>(db,`SELECT c.id,c.created_by,c.kind,c.title,c.department_id,c.project_id,c.country,c.closes_at FROM conversations c
    JOIN conversation_members m ON m.conversation_id=c.id WHERE c.id=? AND c.org_id=? AND m.employee_id=? AND ${filter.sql} FOR SHARE OF c FOR KEY SHARE OF m`,target,actor.org_id,actor.id,...filter.args);
  if(!row) return fail(404,"Conversation not found.");
  return row;
}
async function requireDirectPeer(db: Db, actor: Actor, conversation: string) {
  if (communicationGovernanceEnabled()) {
    if (!await authorizedDirectReply(db,actor,conversation)) return fail(403, "This teammate is outside your current messaging scope.");
    return;
  }

  const peer = await one(db, `SELECT e.id FROM conversation_members m JOIN employees e ON e.id=m.employee_id
    WHERE m.conversation_id=? AND e.org_id=? AND e.id<>? AND e.status='Active' AND e.employment_status<>'Ended'
      AND e.role<>'guest' AND (?=1 OR e.role='super_admin' OR e.department_id=? OR e.manager_id=? OR e.id=?)`,
    conversation, actor.org_id, actor.id, canSuper(actor)?1:0, actor.department_id, actor.id, actor.manager_id);
  if (!peer) return fail(403, "This teammate is outside your current messaging scope.");
}
export async function messageDocumentChoices(db: Db, actor: Actor, conversation: string, query: string) {
  if (!messageDocumentsEnabled()) return fail(404, "Document attachments are unavailable.");
  await throttle(db, `message-documents:${actor.id}`, 60, 60_000);
  return db.transaction(async (tx) => {
    const target = await channel(tx, actor, str(conversation, "conversation", 80), await communicationPolicy(tx, actor));
    if (target.kind === "External") return fail(403, "Document attachments are for internal conversations.");
    if (target.kind === "Direct") await requireDirectPeer(tx, actor, target.id);
    return json({ documents: await attachableDocuments(tx, actor, str(query, "document search", 100, false)) });
  });
}

export async function messagesFor(db:Db,actor:Actor,target:string,query:string,before:string,pinned=false){
  const q=str(query,"search",100,false);
  const cursor=str(before,"history cursor",150,false);
  return db.transaction(async tx=>{
    const policy=await communicationPolicy(tx,actor);
    await channel(tx,actor,target,policy);
    const cutoff=retentionCutoff(policy.message_retention_days);
    const attachments = messageDocumentsEnabled() && actor.role !== "guest";
    const rows=await all<{id:string;created_at:string;document_id:string|null}>(tx,`SELECT m.id,m.body,m.sender_id,m.edited_at,m.deleted_at,m.pinned,
      ${attachments ? "CASE WHEN m.deleted_at IS NULL THEN m.document_id END" : "NULL::text"} AS document_id,
      m.created_at,m.forwarded,e.name,quote.body AS reply_body,author.name AS reply_name,
      (SELECT string_agg(r.emoji,' ' ORDER BY r.emoji) FROM message_reactions r WHERE r.message_id=m.id) AS reactions
      FROM messages m JOIN employees e ON e.id=m.sender_id
      LEFT JOIN messages quote ON quote.id=m.reply_to AND quote.conversation_id=m.conversation_id AND quote.deleted_at IS NULL AND quote.created_at>=?
      LEFT JOIN employees author ON author.id=quote.sender_id
      WHERE m.conversation_id=? AND m.created_at>=?
      AND (?=0 OR (m.pinned=1 AND m.deleted_at IS NULL))
      AND (?='' OR m.created_at || '/' || m.id < ?)
      AND (?='' OR (m.deleted_at IS NULL AND strpos(lower(m.body),lower(?))>0))
      ORDER BY m.created_at DESC,m.id DESC LIMIT 51`,cutoff,target,cutoff,pinned?1:0,cursor,cursor,q,q);
    const members=await all(tx,`SELECT e.id,e.name,e.role,m.last_read_at,u.name AS department FROM conversation_members m JOIN employees e ON e.id=m.employee_id
      LEFT JOIN units u ON u.id=e.department_id AND u.org_id=e.org_id AND u.kind='Department' WHERE m.conversation_id=? AND e.status='Active' AND e.employment_status<>'Ended' ORDER BY e.name`,target);
    const page=rows.slice(0,50), last=page.at(-1);
    const names = new Map<string, string | null>();
    if (page.some(row => row.document_id)) {
      const evaluation = await documentEvaluation(tx, actor);
      for (const document of new Set(page.flatMap(row => row.document_id ? [row.document_id] : []))) {
        names.set(document, await messageDocumentName(tx, actor, document, evaluation));
      }
    }
    const visible = page.reverse().map(({document_id: document, ...row}) => {
      const name = document ? names.get(document) : null;
      return { ...row, attachment_id: name ? document : null, attachment_name: name ?? null, attachment_unavailable: document && !name ? 1 : 0 };
    });
    return json({rows:visible,members,next:rows.length>50&&last?`${last.created_at}/${last.id}`:null});
  });
}
export async function messageViews(db:Db,actor:Actor) {
  const policy=await communicationPolicy(db,actor),filter=activeChannels(actor,policy);
  const rows=await all(db,`SELECT c.id,CASE WHEN c.kind='Direct' THEN COALESCE((SELECT e.name FROM conversation_members n JOIN employees e ON e.id=n.employee_id WHERE n.conversation_id=c.id AND n.employee_id<>? LIMIT 1),c.title)
      ELSE c.title END AS title,c.kind,c.created_by,c.closes_at,m.archived,
      (SELECT MAX(msg.created_at) FROM messages msg WHERE msg.conversation_id=c.id AND msg.created_at>=?) AS last_message_at,
      (SELECT CASE WHEN msg.deleted_at IS NULL THEN COALESCE(NULLIF(left(msg.body,90),''),'Shared a document') ELSE 'Message removed' END
        FROM messages msg WHERE msg.conversation_id=c.id AND msg.created_at>=?
        ORDER BY msg.created_at DESC,msg.id DESC LIMIT 1) AS preview,
      (SELECT count(*)::int FROM messages msg WHERE msg.conversation_id=c.id AND msg.sender_id<>? AND msg.deleted_at IS NULL AND msg.created_at>=? AND (m.last_read_at IS NULL OR msg.created_at>m.last_read_at)) AS unread
      FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id WHERE c.org_id=? AND m.employee_id=? AND ${filter.sql}
      ORDER BY COALESCE((SELECT MAX(msg.created_at) FROM messages msg WHERE msg.conversation_id=c.id),c.created_at) DESC,c.id`,
      actor.id,retentionCutoff(policy.message_retention_days),retentionCutoff(policy.message_retention_days),actor.id,retentionCutoff(policy.message_retention_days),actor.org_id,actor.id,...filter.args);
  const staff=await (communicationGovernanceEnabled()?communicationGroupPeople(db,actor):teamOptions(db,actor));
  if (communicationAdmin(actor)&&policy.external_messaging) {
    staff.push(...await all<Row>(db,`SELECT id,name,'Guest' AS role FROM employees WHERE org_id=? AND role='guest' AND status='Active' AND employment_status<>'Ended' ORDER BY name`,actor.org_id));
  }
  const removedGroups=actor.role==="guest"?[]:await all(db,`SELECT id,title,kind FROM conversations
    WHERE org_id=? AND kind<>'Direct' AND status='Removed' AND (?=1 OR created_by=?)
    ORDER BY title,id LIMIT 100`,actor.org_id,canSuper(actor)?1:0,actor.id);
  return json({rows,staff,removedGroups,communicationGovernanceEnabled:communicationGovernanceEnabled(),
    communicationOversight:Object.values(communicationAccess(actor)).some(Boolean),messageDocumentsEnabled:messageDocumentsEnabled()&&actor.role!=="guest",
    groups:canCreateGroups(actor,policy)?conversationKinds.filter(kind=>kind!=="Direct"
      && ((kind!=="Company"&&kind!=="External")||communicationAdmin(actor))
      && (kind!=="Private"||canManage(actor))
      && (kind!=="External"||policy.external_messaging)) : [],
    departments:canCreateGroups(actor,policy)?await all(db,`SELECT id,name FROM units WHERE org_id=? AND kind='Department' AND (?=1 OR id=?) ORDER BY name`,actor.org_id,canSuper(actor)?1:0,actor.department_id):[],
    projects:canCreateGroups(actor,policy)?await all(db,`SELECT id,name FROM projects WHERE org_id=? AND (?=1 OR owner_id=? OR department_id=?) ORDER BY name`,actor.org_id,canSuper(actor)?1:0,actor.id,actor.department_id):[],
    canForwardMessages:canForwardMessages(actor,policy),memberManagement:policy.member_management,messageChanges:policy.message_changes,
    communicationPolicy:canSuper(actor)?policy:undefined,
    pendingGroups:communicationAdmin(actor)?await all(db,`SELECT c.id,c.title,c.kind,e.name,c.created_at FROM conversations c JOIN employees e ON e.id=c.created_by
      WHERE c.org_id=? AND c.status='Pending' AND (c.closes_at IS NULL OR c.closes_at>?)
      AND (?=1 OR e.department_id=? OR e.manager_id=?) ORDER BY c.created_at`,actor.org_id,now(),canSuper(actor)?1:0,actor.department_id,actor.id):[],
  });
}
async function eligibleParticipant(db:Db,actor:Actor,target:string,scope:ChannelScope) {
  if(scope.kind==="External") {
    const employee=await one<Actor>(db,`SELECT * FROM employees WHERE id=? AND org_id=? AND status='Active' AND employment_status<>'Ended'
      AND (?=1 OR role='guest' OR department_id=? OR manager_id=? OR id=?)`,target,actor.org_id,canSuper(actor)?1:0,actor.department_id,actor.id,actor.id);
    if(!employee) return fail(404,"Participant is unavailable.");
    return employee;
  }
  const managed = communicationGovernanceEnabled();
  const person=await (managed ? eligibleGroupPeer(db,actor,target) : colleague(db,actor,target));
  if (person.employment_status==="Ended" ||
      (scope.department_id&&scope.department_id!==person.department_id &&
        (!managed || !await inCommunicationDepartment(db,person,scope.department_id))) ||
      (scope.country&&scope.country!==person.country) ||
      (scope.kind==="Private"&&!canManage(person))) return fail(403,"That participant is outside the group’s scope.");
  if(scope.project_id && !await one(db,`SELECT p.id FROM projects p WHERE p.id=? AND p.org_id=?
    AND (p.owner_id=? OR p.department_id=? OR EXISTS (SELECT 1 FROM tasks t WHERE t.project_id=p.id AND t.employee_id=?))`,scope.project_id,actor.org_id,person.id,person.department_id,person.id)) return fail(403,"That participant is outside the project.");
  return person;
}
export async function messageAction(db:Db,actor:Actor,action:string,data:Record<string,unknown>){
  const limit=action==="send"||action==="forward"?40:120;
  await throttle(db,`messages:${actor.id}:${limit}`,limit,60_000);
  return db.transaction(tx=>mutateMessages(tx,actor,action,data));
}
async function mutateMessages(db:Db,actor:Actor,action:string,data:Record<string,unknown>){
  const policy = await communicationPolicy(db,actor);
  if (communicationGovernanceEnabled()) {
    if(action==="check-direct") return checkDirect(db,actor,data);
    if(action==="people") return communicationPeople(db,actor,data);
    if(action==="oversight") return communicationOversight(db,actor,data,retentionCutoff(policy.message_retention_days));
    if(action==="oversight-content") return communicationContent(db,actor,data,retentionCutoff(policy.message_retention_days));
    if(action==="directory-visibility") return communicationVisibility(db,actor,data);
    if(action==="communication-support") return communicationSupport(db,actor,data);
  }
  if(action==="remove-group"||action==="restore-group"){
    requireStaff(actor);
    const target = str(data.conversation,"conversation",80);
    const restoring = action==="restore-group";
    const group = await one<{created_by:string; kind:string; status:string; closes_at:string|null}>(db,
      "SELECT created_by,kind,status,closes_at FROM conversations WHERE id=? AND org_id=? AND kind<>'Direct' FOR NO KEY UPDATE",target,actor.org_id);
    if (!group || (!canSuper(actor) && group.created_by!==actor.id)) return fail(404,"Group not found.");
    if (group.kind==="External" && !communicationAdmin(actor)) return fail(403,"Administrator access is required for guest groups.");
    if (group.status!==(restoring?"Removed":"Active")) return fail(409,restoring?"This group is not removed.":"This group is not active.");
    if (restoring && group.closes_at && group.closes_at<=now()) return fail(409,"This temporary group has expired.");
    if (restoring && group.kind==="External" && !policy.external_messaging) return fail(409,"Guest conversations are disabled by messaging policy.");
    await run(db,"UPDATE conversations SET status=? WHERE id=? AND org_id=?",restoring?"Active":"Removed",target,actor.org_id);
    await audit(db,actor,restoring?"Group restored":"Group removed","conversation",target).run();
    return json({ok:true,message:restoring?"Group restored.":"Group removed for all participants."});
  }
  if(action==="review"){
    if(!communicationAdmin(actor)) return fail(403,"Administrator access is required.");
    const target = str(data.conversation,"conversation",80);
    const status = pick(data.status,["Active","Rejected"],"approval decision");
    await db.transaction(async (tx) => {
      const group = await one<{created_by:string}>(tx,"SELECT created_by FROM conversations WHERE id=? AND org_id=? AND status='Pending' AND (closes_at IS NULL OR closes_at>?) FOR UPDATE",target,actor.org_id,now());
      if (!group) return fail(404,"Group request not found.");
      if(!canSuper(actor)) {
        const invalid=await one(tx,`SELECT m.id FROM conversation_members m JOIN employees e ON e.id=m.employee_id
          WHERE m.conversation_id=? AND NOT (e.id=? OR e.department_id IS NOT DISTINCT FROM ? AND ?::text IS NOT NULL OR e.manager_id=?)
          LIMIT 1`,target,actor.id,actor.department_id,actor.department_id,actor.id);
        if(invalid) return fail(403,"The group includes employees outside your administration scope.");
      }
      await run(tx,"UPDATE conversations SET status=? WHERE id=?",status,target);
      await audit(tx,actor,status==="Active"?"Group approved":"Group rejected","conversation",target).run();
      await notify(tx,group.created_by,"Group request reviewed",status==="Active"?"Your group is ready to use.":"Your group request was declined.","/staff/messages").run();
      if(status==="Active") await notifyConversation(tx,actor,target,"You were added to a conversation",group.created_by);
    });
    return json({ok:true,message:status==="Active"?"Group approved.":"Group request declined."});
  }
  if(action==="create"){
    requireStaff(actor);
    const kind=pick(data.kind,conversationKinds,"conversation type");
    if(kind!=="Direct"&&!canCreateGroups(actor,policy)) return fail(403,"You do not have permission to create groups.");
    if((kind==="Company"||kind==="External")&&!communicationAdmin(actor)) return fail(403,"This group requires administrator access.");
    if(kind==="Private"&&!canManage(actor)) return fail(403,"Management access is required for this group.");
    if(kind==="External"&&!policy.external_messaging) return fail(403,"Guest conversations are disabled.");
    const selection=kind==="Direct"&&typeof data.members==="string"?[data.members]:data.members;
    const participants=memberIds(selection).filter((member)=>member!==actor.id);
    if(kind==="Direct"&&participants.length!==1) return fail(400,"Choose one teammate for a direct message.");
    if(!participants.length) return fail(400,"Choose at least one teammate.");
    const department=kind==="Department"?str(data.department,"department",80):null;
    const project=kind==="Project"?str(data.project,"project",80):null;
    const market=kind==="Country"?country(data.country):null;
    const closes=kind==="Temporary"?datetime(data.closesAt,"closing date"):null;
    if(closes&&closes<=now()) return fail(400,"Choose a future closing date.");
    if(department&&((!canSuper(actor)&&actor.department_id!==department
      &&(!communicationGovernanceEnabled()||!await inCommunicationDepartment(db,actor,department)))
      ||!await one(db,"SELECT id FROM units WHERE id=? AND org_id=? AND kind='Department'",department,actor.org_id))) return fail(403,"Choose a department you can manage.");
    if(project&&!await one(db,"SELECT id FROM projects WHERE id=? AND org_id=? AND (?=1 OR owner_id=? OR department_id=?)",project,actor.org_id,canSuper(actor)?1:0,actor.id,actor.department_id)) return fail(403,"Choose a project within your scope.");
    if(market&&!canSuper(actor)&&actor.country!==market) return fail(403,"Choose your assigned country.");
    const scope={kind,department_id:department,project_id:project,country:market,closes_at:closes};
    let crossDepartment = false;
    let directName: string | undefined;
    if(kind==="Direct"){
      await one(db,"SELECT id FROM organizations WHERE id=? FOR UPDATE",actor.org_id);
      const governed = communicationGovernanceEnabled();
      const peer = governed ? await directPeer(db,actor,participants[0]) : null;
      directName = peer?.name ?? (await eligibleParticipant(db,actor,participants[0],scope)).name;
      const existing = await existingDirect(db,actor,participants[0]);
      if(existing) {
        await run(db,"UPDATE conversation_members SET archived=0 WHERE conversation_id=? AND employee_id=? AND archived=1",existing.id,actor.id);
        return json({ok:true,id:existing.id,message:"Conversation opened."});
      }
      crossDepartment = peer ? mustConfirmCrossDepartment(peer) : false;
      if(crossDepartment && data.crossDepartmentConfirmed!==true)
        return fail(409,"Confirm that you want to start a cross-department conversation.");
    } else {
      await Promise.all(participants.map(employee=>eligibleParticipant(db,actor,employee,scope)));
    }
    const target=id(),title=directName??str(data.title,"channel name",100);
    const status = kind!=="Direct" && policy.group_approval && !communicationAdmin(actor) ? "Pending" : "Active";
    await db.batch([
      stmt(db,"INSERT INTO conversations (id,org_id,title,kind,created_by,status,department_id,project_id,country,closes_at) VALUES (?,?,?,?,?,?,?,?,?,?)",target,actor.org_id,title,kind,actor.id,status,department,project,market,closes),
      ...[actor.id,...participants].map((employee)=>stmt(db,"INSERT INTO conversation_members (id,conversation_id,employee_id) VALUES (?,?,?)",id(),target,employee)),
      audit(db,actor,status==="Active"?"Conversation created":"Group requested","conversation",target),
      ...(crossDepartment ? [audit(db,actor,"Cross-department conversation confirmed","conversation",target)] : []),
      ...[actor.id,...participants].map(employee=>audit(db,actor,"Conversation participant invited","conversation membership",`${target}/${employee}`)),
    ]);
    if (status==="Active") await notifyConversation(db,actor,target,crossDepartment?"New cross-department conversation":"You were added to a conversation");
    else await run(db,`INSERT INTO notifications (id,employee_id,title,body,href)
      SELECT ? || id,id,'Group request awaiting review','Review the request in Messages.','/staff/messages'
      FROM employees WHERE org_id=? AND role IN ('super_admin','admin') AND status='Active' AND employment_status<>'Ended'
      AND (role='super_admin' OR department_id=? OR id=?)`,id(),actor.org_id,actor.department_id,actor.manager_id);
    return json(status==="Active"
      ? {ok:true,id:target,message:"Conversation created."}
      : {ok:true,message:"Group request sent for administrator approval."},201);
  }
  const target=str(data.conversation,"conversation",80);
  const conversation=await channel(db,actor,target,policy);
  if(action==="forward"){
    if(!canForwardMessages(actor,policy)||conversation.kind==="External") return fail(403,"Forwarding is available only in permitted internal conversations.");
    const destination = str(data.destination,"destination conversation",80);
    if(destination===target) return fail(400,"Choose a different conversation.");
    const sourceId = str(data.id,"message",80);
    const receiving = await channel(db,actor,destination,policy);
    if(receiving.kind==="External") return fail(403,"Messages cannot be forwarded into guest conversations.");
    if(receiving.kind==="Direct") await requireDirectPeer(db,actor,destination);
    await db.transaction(async (tx) => {
      const enabled = messageDocumentsEnabled();
      const source = await one<{ body: string; document_id: string | null }>(tx, `SELECT body,
        ${enabled ? "document_id" : "NULL::text AS document_id"} FROM messages
        WHERE id=? AND conversation_id=? AND deleted_at IS NULL AND created_at>=? FOR SHARE`,
        sourceId,target,retentionCutoff(policy.message_retention_days));
      if(!source || (!enabled && !source.body)) return fail(404,"Message or receiving conversation is unavailable.");
      if (source.document_id) await shareMessageDocument(tx, actor, destination, receiving.kind, source.document_id);
      if (enabled) {
        await run(tx,"INSERT INTO messages (id,conversation_id,sender_id,body,forwarded,document_id) VALUES (?,?,?,?,1,?)",
          id(),destination,actor.id,source.body,source.document_id);
      } else {
        await run(tx,"INSERT INTO messages (id,conversation_id,sender_id,body,forwarded) VALUES (?,?,?,?,1)",
          id(),destination,actor.id,source.body);
      }
      await audit(tx,actor,"Message forwarded","conversation",destination).run();
      await notifyConversation(tx,actor,destination,"New message");
    });
    return json({ok:true,message:"Message forwarded."},201);
  }
  if(action==="send"){
    if(conversation.kind==="Direct") await requireDirectPeer(db,actor,target);
    const reply=str(data.reply,"reply",80,false);
    if(reply&&!await one(db,"SELECT id FROM messages WHERE id=? AND conversation_id=? AND deleted_at IS NULL AND created_at>=?",reply,target,retentionCutoff(policy.message_retention_days))) return fail(400,"The message you are replying to is unavailable.");
    const mention = str(data.mention,"mention",80,false);
    const selected=memberIds(data.mentions??[],20);
    if(mention&&!selected.includes(mention))selected.push(mention);
    const document = str(data.document,"document",80,false);
    const message=id(),body=str(data.body,"message",4000,!document);
    await db.transaction(async (tx) => {
      const membership = await one(tx,"SELECT id FROM conversation_members WHERE conversation_id=? AND employee_id=? FOR KEY SHARE",target,actor.id);
      if (!membership) return fail(404,"Conversation not found.");
      let text = body;
      for (const person of selected) {
        const member = await one<{name:string}>(tx,`SELECT e.name FROM conversation_members m JOIN employees e ON e.id=m.employee_id
          WHERE m.conversation_id=? AND m.employee_id=? AND e.status='Active' AND e.employment_status<>'Ended' AND e.id<>? FOR KEY SHARE OF m`,target,person,actor.id);
        if (!member) return fail(400,"Choose a permitted participant to mention.");
        if(person===mention&&!text.includes(`@${member.name}`))text=str(`@${member.name} ${text}`,"message",4000);
        if(!text.includes(`@${member.name}`))return fail(400,"Insert the selected mention into your message.");
        await notify(tx,person,"Mentioned in a conversation",`${actor.name} mentioned you.`,`/staff/messages?conversation=${target}`).run();
      }
      if (document) {
        await shareMessageDocument(tx, actor, target, conversation.kind, document);
        await run(tx,"INSERT INTO messages (id,conversation_id,sender_id,body,reply_to,document_id) VALUES (?,?,?,?,?,?)",
          message,target,actor.id,text,reply||null,document);
      } else {
        await run(tx,"INSERT INTO messages (id,conversation_id,sender_id,body,reply_to) VALUES (?,?,?,?,?)",message,target,actor.id,text,reply||null);
      }
      await notifyConversation(tx,actor,target,"New message",selected);
    });
    return json({ok:true,id:message},201);
  }
  if(action==="read"||action==="archive"){
    if(action==="read") {
      const through=str(data.through,"message read",80);
      const message=await one<{created_at:string}>(db,"SELECT created_at FROM messages WHERE id=? AND conversation_id=? AND created_at>=?",through,target,retentionCutoff(policy.message_retention_days));
      if(!message) return fail(404,"Message not found.");
      await run(db,`UPDATE conversation_members SET last_read_at=?
        WHERE conversation_id=? AND employee_id=? AND (last_read_at IS NULL OR last_read_at<?)`,message.created_at,target,actor.id,message.created_at);
    }
    else await run(db,"UPDATE conversation_members SET archived=? WHERE conversation_id=? AND employee_id=?",data.archived==="1"?1:0,target,actor.id);
    return json({ok:true});
  }
  if(action==="member"){
    if(conversation.kind==="Direct"||(!communicationAdmin(actor)&&conversation.kind==="External")||!canManageGroupMembers(actor,conversation.created_by,policy)) return fail(403,"You cannot manage this conversation.");
    const employee=str(data.employee,"employee",80);
    if(employee===conversation.created_by) return fail(400,"The conversation owner must remain a member.");
    const operation=pick(data.operation,["add","remove"],"membership action");
    if(operation==="remove"){
      const removed=await run(db,"DELETE FROM conversation_members WHERE conversation_id=? AND employee_id=?",target,employee);
      if(removed.count) await audit(db,actor,"Channel member removed","conversation membership",`${target}/${employee}`).run();
    }else {
      await eligibleParticipant(db,actor,employee,conversation);
      const added=await run(db,"INSERT INTO conversation_members (id,conversation_id,employee_id) VALUES (?,?,?) ON CONFLICT DO NOTHING",id(),target,employee);
      if(added.count) {
        await audit(db,actor,"Channel member added","conversation membership",`${target}/${employee}`).run();
        await notify(db,employee,"You were added to a conversation","Open Messages to view the conversation.",`/staff/messages?conversation=${target}`).run();
      }
    }
    return json({ok:true,message:"Channel membership updated."});
  }
  const message=str(data.id,"message",80);
  const row=await one<{sender_id:string}>(db,"SELECT sender_id FROM messages WHERE id=? AND conversation_id=? AND deleted_at IS NULL AND created_at>=?",message,target,retentionCutoff(policy.message_retention_days));
  if(!row) return fail(404,"Message not found.");
  if(action==="reaction"){
    const emoji=pick(data.emoji,messageReactions,"reaction");
    const present=await one(db,"SELECT id FROM message_reactions WHERE message_id=? AND employee_id=? AND emoji=?",message,actor.id,emoji);
    if(present) await run(db,"DELETE FROM message_reactions WHERE message_id=? AND employee_id=? AND emoji=?",message,actor.id,emoji);
    else await run(db,"INSERT INTO message_reactions (id,message_id,employee_id,emoji) VALUES (?,?,?,?) ON CONFLICT DO NOTHING",id(),message,actor.id,emoji);
    return json({ok:true});
  }
  if(action==="pin"){
    if(conversation.created_by!==actor.id&&!communicationAdmin(actor)) return fail(403,"Only the conversation owner or an administrator can pin messages.");
    await run(db,"UPDATE messages SET pinned=? WHERE id=?",data.pinned==="1"?1:0,message);
    return json({ok:true});
  }
  if(policy.message_changes==="Locked") return fail(403,"Editing and removal are disabled by your workspace policy.");
  if(row.sender_id!==actor.id&&!(action==="delete"&&policy.message_changes==="Sender or Super Admin"&&canSuper(actor))) return fail(403,"You do not have permission to edit or remove this message.");
  if(action==="edit") {
    await run(db,"UPDATE messages SET body=?,edited_at=? WHERE id=?",str(data.body,"message",4000),now(),message);
    await audit(db,actor,"Message edited","message",message).run();
  }
  else if(action==="delete") {
    await run(db,"UPDATE messages SET body='',deleted_at=?,pinned=0 WHERE id=?",now(),message);
    await audit(db,actor,"Message removed","message",message).run();
  }
  else return fail(404,"Message action unavailable.");
  return json({ok:true});
}

async function notifyConversation(db:Db,actor:Actor,target:string,title:string,excluded:string|string[]=actor.id) {
  const exclusions=[actor.id,...(Array.isArray(excluded)?excluded:[excluded])];
  await run(db,`INSERT INTO notifications (id,employee_id,title,body,href)
    SELECT ? || m.id,e.id,?,'Open Messages to view the conversation.',?
    FROM conversation_members m JOIN employees e ON e.id=m.employee_id
    WHERE m.conversation_id=? AND e.org_id=? AND e.id NOT IN (${exclusions.map(()=>"?").join(",")}) AND e.status='Active' AND e.employment_status<>'Ended'`,
    id(),title,`/staff/messages?conversation=${target}`,target,actor.org_id,...exclusions);
}

const allowedFiles:Record<string,string>={pdf:"application/pdf",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",
  webp:"image/webp",docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"};
function fileMatches(ext:string,bytes:Buffer){
  if(ext==="pdf") return bytes.subarray(0,5).toString()==="%PDF-";
  if(ext==="png") return bytes.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex"));
  if(ext==="jpg"||ext==="jpeg") return bytes.subarray(0,3).equals(Buffer.from("ffd8ff","hex"));
  if(ext==="webp") return bytes.subarray(0,4).toString()==="RIFF"&&bytes.subarray(8,12).toString()==="WEBP";
  return bytes.subarray(0,4).equals(Buffer.from("504b0304","hex"));
}
export async function uploadDocument(db:Db,actor:Actor,request:Request){
  requireStaff(actor);
  const max=3*1024*1024;
  if(Number(request.headers.get("content-length")||0)>max+10000) return fail(413,"Choose a file under 3 MB.");
  await throttle(db,`upload:${actor.id}`,12,60_000);
  const data=await request.formData(),file=data.get("file");
  if(!(file instanceof File)||file.size<1||file.size>max) return fail(400,"Choose a supported file under 3 MB.");
  const name=file.name.replace(/[\/\\\u0000-\u001f]/g,"_").slice(0,130);
  const extension=name.split(".").pop()?.toLowerCase()??"";
  const mime=allowedFiles[extension],bytes=Buffer.from(await file.arrayBuffer());
  if(!mime||!fileMatches(extension,bytes)) return fail(400,"Choose a valid PDF, Word, Excel, PNG, JPG or WebP file.");
  const target=id();
  await db.batch([
    stmt(db,"INSERT INTO file_objects (id,content) VALUES (?,?)",target,bytes),
    stmt(db,"INSERT INTO documents (id,org_id,owner_id,name,mime,bytes,storage_key) VALUES (?,?,?,?,?,?,?)",target,actor.org_id,actor.id,name,mime,file.size,target),
    audit(db,actor,"Document uploaded","document",target),
  ]);
  return json({ok:true,message:"Private document uploaded."},201);
}
export async function downloadDocument(db:Db,actor:Actor,target:string,preview=false){
  const row=await one<{name:string;mime:string;content:Uint8Array}>(db,`SELECT d.name,d.mime,f.content FROM documents d JOIN file_objects f ON f.id=d.storage_key
    LEFT JOIN document_grants g ON g.document_id=d.id AND g.employee_id=?
    WHERE d.id=? AND d.org_id=? AND d.revoked_at IS NULL AND (d.owner_id=? OR g.allow_download=1)`,actor.id,target,actor.org_id,actor.id);
  if(!row) return fail(404,"This file is unavailable or download access has not been granted.");
  const inline=preview&&(["application/pdf","image/jpeg","image/png","image/webp"].includes(row.mime));
  await audit(db,actor,inline?"Document preview opened":"Document downloaded","document",target).run();
  return new Response(Uint8Array.from(row.content),{headers:{
    "Content-Type":inline?row.mime:"application/octet-stream",
    "Content-Disposition":`${inline?"inline":"attachment"}; filename*=UTF-8''${encodeURIComponent(row.name).replace(/'/g,"%27")}`,
    "Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"sandbox; default-src 'none'",
  }});
}
export async function documentAction(db:Db,actor:Actor,action:string,data:Record<string,unknown>){
  requireStaff(actor);
  const target=str(data.id,"document",80);
  const entry=await one<{owner_id:string;revoked_at:string|null}>(db,"SELECT owner_id,revoked_at FROM documents WHERE id=? AND org_id=?",target,actor.org_id);
  if(!entry) return fail(404,"Document unavailable.");
  if(entry.owner_id!==actor.id&&!canSuper(actor)) return fail(403,"Only the owner or Super Admin can manage access.");
  if(action==="revoke"){
    await db.batch([stmt(db,"UPDATE documents SET revoked_at=? WHERE id=? AND revoked_at IS NULL",now(),target),audit(db,actor,"Document access revoked","document",target)]);
    return json({ok:true,message:"Document access revoked."});
  }
  if(entry.revoked_at) return fail(409,"This document is revoked.");
  if(action==="share"){
    const employee=await colleague(db,actor,str(data.employee,"teammate",80));
    await db.batch([
      stmt(db,`INSERT INTO document_grants (id,document_id,employee_id,allow_download) VALUES (?,?,?,?)
        ON CONFLICT(document_id,employee_id) DO UPDATE SET allow_download=excluded.allow_download`,id(),target,employee.id,data.download==="1"?1:0),
      audit(db,actor,"Document shared internally","document",target),
      notify(db,employee.id,"Document shared","A colleague shared a file with you.","/staff/documents"),
    ]);
    return json({ok:true,message:"Document shared with the selected teammate."});
  }
  if(action==="unshare"){
    const employee=str(data.employee,"teammate",80);
    await db.batch([stmt(db,"DELETE FROM document_grants WHERE document_id=? AND employee_id=?",target,employee),audit(db,actor,"Document grant removed","document",target)]);
    return json({ok:true,message:"Sharing permission removed."});
  }
  return fail(404,"Document action unavailable.");
}

export async function teamOptions(db:Db,actor:Actor){
  if(actor.role==="guest") return [];
  return all<Row>(db,`SELECT e.id,e.name,e.title,e.employee_no,u.name AS department FROM employees e LEFT JOIN units u ON u.id=e.department_id
    WHERE e.org_id=? AND e.status='Active' AND e.employment_status<>'Ended' AND e.role<>'guest'
    AND (?=1 OR e.id=? OR (e.department_id IS NOT NULL AND e.department_id=?) OR e.manager_id=? OR e.id=?) ORDER BY e.name LIMIT 200`,
    actor.org_id,canSuper(actor)?1:0,actor.id,actor.department_id,actor.id,actor.manager_id);
}
