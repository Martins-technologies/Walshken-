import assert from "node:assert/strict";

export async function verifyCommunicationGovernance(context) {
  const {db,request,admin,adminId,staff,staffId,guest,scopedAdmin,scopedAdminId,department,scopedDirect,employee,secret,enroll}=context;
  const comm=(action,user,body,status=200)=>request("messages/"+action,status,user,body);
  async function person(label,role,department) {
    const account={email:label.toLowerCase()+"@walshken.test",password:secret(),cookie:""};
    const invitation=await request("employees/add",201,admin,{
      ...employee,email:account.email,employeeNo:"QA-"+label,name:label,role,department,
    });
    await request("session/activate",200,account,{...account,code:invitation.code});
    await request("session/login",200,account,account);
    await enroll(account);
    return {account,id:(await db.prepare("SELECT id FROM employees WHERE email=?",[account.email]).first()).id};
  }
  async function grant(principal,capability,scopeType="organization",scopeId="",effect="allow") {
    await request("governance/permission-save",200,admin,{
      principalType:"employee",principal,capability,scopeType,scopeId,effect,
    });
  }
  async function unit(id,name,kind="Department") {
    await db.prepare("INSERT INTO units(id,org_id,name,kind) VALUES(?,'walshken',?,?)",[id,name,kind]).run();
  }
  await unit("qa-finance","Finance");
  await unit("qa-support","Support");
  await unit("qa-team","QA Support Team","Team");
  const finance=await person("FinanceColleague","employee","qa-finance");
  const support=await person("SupportColleague","employee","qa-support");
  const hr=await person("HrReviewer","hr",department);
  const manager=await person("DepartmentManager","manager",department);
  const unaffiliated=await person("NoDepartment","employee","");
  const people=async (user,query="")=>(await comm("people",user,{query})).rows;
  const check=(sender,recipient,status=200)=>comm("check-direct",sender,{employee:recipient},status);
  const create=(sender,recipient,status,crossDepartmentConfirmed)=>comm("create",sender,{
    kind:"Direct",members:recipient,crossDepartmentConfirmed,
  },status);
  const findMember=async (user,recipient)=>!!(await people(user)).some(row=>row.id===recipient);

  assert.deepEqual(await check(staff,scopedAdminId),{confirmationRequired:false});
  await create(staff,scopedAdminId,200);
  await check(staff,finance.id,404);
  await create(staff,finance.id,404,true);
  await check(staff,unaffiliated.id,404);
  await check(guest,finance.id,403);
  await grant(staffId,"communication.direct","employee",finance.id);
  await grant(staffId,"communication.direct","employee",unaffiliated.id);
  assert.deepEqual(await check(staff,unaffiliated.id),{confirmationRequired:true});
  assert.equal(await findMember(staff,finance.id),true);
  assert.deepEqual(await check(staff,finance.id),{confirmationRequired:true});
  assert.equal((await db.prepare(`SELECT count(*)::int AS n FROM conversation_members m JOIN conversation_members peer
    ON peer.conversation_id=m.conversation_id WHERE m.employee_id=? AND peer.employee_id=?`,[staffId,finance.id]).first()).n,0,
    "checking and then cancelling cannot open or create a conversation");
  await create(staff,finance.id,409,"true");
  const cross=(await create(staff,finance.id,201,true)).id;
  await comm("send",staff,{conversation:cross,body:"Recorded permission and confirmation"},201);
  await request("conversation/"+cross,200,finance.account);
  await check(finance.account,staffId,404);
  await comm("send",finance.account,{conversation:cross,body:"Reply under the opener’s direct grant"},201);
  await grant(finance.id,"communication.direct","employee",staffId,"deny");
  await check(staff,finance.id,404);
  await comm("send",finance.account,{conversation:cross,body:"Denied recipient cannot reply"},403);
  await comm("send",staff,{conversation:cross,body:"Deny also applies to the opener"},403);
  const recipientDeny=await db.prepare(`SELECT id FROM staff_action_permissions WHERE org_id='walshken'
    AND principal_type='employee' AND principal_id=? AND action='communication.direct' AND scope_type='employee'
    AND scope_id=?`,[finance.id,staffId]).first();
  await request("governance/permission-remove",200,admin,{id:recipientDeny.id});
  const openerGrant=await db.prepare(`SELECT id FROM staff_action_permissions WHERE org_id='walshken'
    AND principal_type='employee' AND principal_id=? AND action='communication.direct' AND scope_type='employee'
    AND scope_id=?`,[staffId,finance.id]).first();
  await request("governance/permission-remove",200,admin,{id:openerGrant.id});
  await comm("send",finance.account,{conversation:cross,body:"Revoked opener grant cannot authorize replies"},403);
  await request("conversation/"+cross,200,finance.account);
  await grant(staffId,"communication.direct","employee",finance.id);
  assert.deepEqual(await check(staff,finance.id),{confirmationRequired:false});
  assert.equal((await create(staff,finance.id,200)).id,cross);
  const crossNotification=(await db.prepare("SELECT count(*)::int AS n FROM notifications WHERE employee_id=? AND title='New cross-department conversation'",[finance.id]).first()).n;
  assert.equal(crossNotification,1);
  assert.equal((await db.prepare("SELECT count(*)::int AS n FROM audit WHERE org_id='walshken' AND target_id=? AND action='Cross-department conversation confirmed'",[cross]).first()).n,1);

  await grant(scopedAdminId,"communication.direct","employee",finance.id);
  await grant(scopedAdminId,"communication.direct.silent","employee",finance.id);
  assert.deepEqual(await check(scopedAdmin,finance.id),{confirmationRequired:false});
  await create(scopedAdmin,finance.id,201);
  await db.prepare("INSERT INTO staff_unit_memberships(org_id,employee_id,unit_id,created_by,created_at) VALUES('walshken',?,?,?,?)",
    [hr.id,"qa-finance",adminId,new Date().toISOString()]).run();
  assert.deepEqual(await check(hr.account,finance.id),{confirmationRequired:false});
  assert.ok((await people(support.account,"Finance")).every(row=>row.id!==hr.id));
  await create(hr.account,finance.id,201);

  await comm("communication-support",staff,{department:"qa-support",enabled:true},403);
  await comm("communication-support",admin,{department:"qa-support",enabled:true});
  assert.equal((await people(support.account,"FinanceColleague"))[0]?.id,finance.id);
  assert.equal((await people(support.account,"Finance"))[0]?.id,finance.id);
  assert.deepEqual(await check(staff,support.id),{confirmationRequired:false});
  const supportConversation=(await create(staff,support.id,201)).id;
  await comm("send",support.account,{conversation:supportConversation,body:"Support response"},201);
  await request("conversation/"+supportConversation,200,support.account);
  await request("conversation/"+supportConversation,404,hr.account);
  await create(support.account,manager.id,201);
  await db.prepare("UPDATE organizations SET group_creation='All staff',group_approval=0 WHERE id='walshken'",[]).run();
  const supportGroup=await comm("create",support.account,{kind:"Group",title:"Support triage",members:[finance.id,staffId]},201);
  await request("conversation/"+supportGroup.id,200,finance.account);

  await comm("oversight",staff,{section:"directory"},403);
  await comm("oversight",scopedAdmin,{section:"directory"},403);
  await comm("oversight",hr.account,{section:"conversations"},403);
  await comm("directory-visibility",hr.account,{kind:"employee",target:finance.id,hidden:true},403);
  await comm("directory-visibility",admin,{kind:"employee",target:support.id,hidden:true});
  await comm("directory-visibility",admin,{kind:"employee",target:support.id,hidden:true});
  assert.equal(await findMember(staff,support.id),false);
  assert.equal((await request("view/messages",200,staff)).staff.some(row=>row.id===support.id),false);
  assert.ok((await request("view/messages",200,staff)).rows.some(row=>row.id===supportConversation));
  assert.ok((await request("conversation/"+supportConversation,200,staff)).rows.some(row=>row.body==="Support response"));
  assert.equal((await db.prepare("SELECT status FROM employees WHERE id=?",[support.id]).first()).status,"Active");
  assert.equal((await db.prepare("SELECT count(*)::int AS n FROM notifications WHERE employee_id=? AND title='Communication directory settings updated'",[support.id]).first()).n,1);
  assert.equal((await comm("oversight",admin,{section:"directory",query:"SupportColleague"})).directory[0].hidden,true);
  await comm("directory-visibility",admin,{kind:"employee",target:support.id,hidden:false});
  assert.equal(await findMember(staff,support.id),true);
  await db.prepare("INSERT INTO staff_unit_memberships(org_id,employee_id,unit_id,created_by,created_at) VALUES('walshken',?,?,?,?)",
    [support.id,"qa-team",adminId,new Date().toISOString()]).run();
  await comm("directory-visibility",admin,{kind:"team",target:"qa-team",hidden:true});
  assert.equal(await findMember(staff,support.id),false);
  assert.equal((await comm("oversight",admin,{section:"directory",team:"qa-team"})).directory[0].team_hidden,true);
  await comm("directory-visibility",admin,{kind:"team",target:"qa-team",hidden:false});
  assert.equal(await findMember(staff,support.id),true);
  await comm("directory-visibility",admin,{kind:"department",target:"qa-support",hidden:true});
  assert.equal(await findMember(staff,support.id),false);
  await comm("directory-visibility",admin,{kind:"department",target:"qa-support",hidden:false});

  await grant(hr.id,"communication.metadata","department",department);
  const metadata=await comm("oversight",hr.account,{section:"conversations"});
  assert.equal(metadata.access.content,false);
  assert.ok(metadata.conversations.some(row=>row.id===scopedDirect&&!row.can_read));
  assert.equal(metadata.conversations.some(row=>row.id===supportConversation),false);
  await comm("oversight-content",hr.account,{conversation:scopedDirect,reason:"QA privacy case"},403);
  await grant(hr.id,"communication.content","department",department);
  await comm("oversight-content",hr.account,{conversation:supportConversation,reason:"QA privacy case"},404);
  await comm("oversight-content",hr.account,{conversation:scopedDirect,reason:"   "},400);
  const content=await comm("oversight-content",hr.account,{conversation:scopedDirect,reason:"QA privacy case"});
  assert.ok(content.rows.some(row=>row.body==="Current department teammate"));
  assert.ok(await db.prepare("SELECT id FROM audit WHERE actor_id=? AND target_id=? AND action LIKE 'Private communication reviewed%'",[hr.id,scopedDirect]).first());
  await request("conversation/"+scopedDirect,404,hr.account);

  await db.prepare("INSERT INTO staff_unit_memberships(org_id,employee_id,unit_id,created_by,created_at) VALUES('walshken',?,?,?,?)",
    [finance.id,department,adminId,new Date().toISOString()]).run();
  const mixed=(await comm("create",staff,{kind:"Group",title:"Scoped history regression",members:[finance.id,scopedAdminId]},201)).id;
  await comm("send",staff,{conversation:mixed,body:"Retained in-scope message"},201);
  await comm("send",finance.account,{conversation:mixed,body:"Retained out-of-scope message"},201);
  await db.prepare("DELETE FROM staff_unit_memberships WHERE org_id='walshken' AND employee_id=? AND unit_id=?",[finance.id,department]).run();
  await comm("oversight-content",hr.account,{conversation:mixed,reason:"Scoped history regression"},404);
  await grant(manager.id,"communication.reports","department",department);
  const staffActivity=async ()=>(await comm("oversight",manager.account,{section:"activity",department})).activity.find(row=>row.id===staffId);
  const beforeRemoval=await staffActivity();
  await comm("member",staff,{conversation:mixed,employee:finance.id,operation:"remove"});
  const afterRemoval=await staffActivity();
  assert.equal(afterRemoval.conversations,beforeRemoval.conversations+1,"mixed-scope conversations do not contribute to scoped metrics");
  assert.equal(afterRemoval.messages,beforeRemoval.messages+1);
  const retained=await comm("oversight-content",hr.account,{conversation:mixed,reason:"Scoped history regression"});
  assert.deepEqual(retained.rows.map(row=>row.body),["Retained in-scope message"]);
  assert.equal(retained.total,1);
  const organizationHistory=await comm("oversight-content",admin,{conversation:mixed,reason:"Organization history regression"});
  assert.deepEqual(organizationHistory.rows.map(row=>row.body).sort(),["Retained in-scope message","Retained out-of-scope message"]);
  const mixedMetadata=(await comm("oversight",hr.account,{section:"conversations",query:"Scoped history regression"})).conversations[0];
  assert.equal(mixedMetadata?.last_activity,retained.rows[0].created_at);
  await db.prepare("UPDATE employees SET status='Suspended' WHERE id IN (?,?)",[staffId,scopedAdminId]).run();
  await comm("oversight-content",hr.account,{conversation:mixed,reason:"Scoped history regression"},404);
  assert.equal((await comm("oversight",hr.account,{section:"conversations",query:"Scoped history regression"})).conversations.length,0);
  assert.equal((await staffActivity()).messages,beforeRemoval.messages-1,"messages with no active scoped members are excluded");
  await db.prepare("UPDATE employees SET status='Active' WHERE id IN (?,?)",[staffId,scopedAdminId]).run();

  await grant(hr.id,"communication.content","department",department,"deny");
  await comm("oversight-content",hr.account,{conversation:scopedDirect,reason:"QA privacy case"},403);
  await grant(scopedAdminId,"communication.visibility.employee","employee",staffId);
  const visibility=await comm("oversight",scopedAdmin,{section:"directory"});
  assert.deepEqual(visibility.directory.map(row=>row.id),[staffId]);
  await comm("directory-visibility",scopedAdmin,{kind:"employee",target:finance.id,hidden:true},404);
  await grant(manager.id,"communication.visibility.team","department",department);
  await comm("directory-visibility",manager.account,{kind:"team",target:"qa-team",hidden:true},404);
  const activity=await comm("oversight",manager.account,{section:"activity",department});
  assert.ok(activity.activity.some(row=>row.id===staffId&&row.messages>0));
  assert.equal(activity.activity.some(row=>row.id===finance.id),false);
  const filtered=await comm("oversight",manager.account,{section:"activity",team:"qa-team"});
  assert.equal(filtered.activity.length,0);

  await db.prepare("INSERT INTO organizations(id,name,time_zone) VALUES('qa-other-org','Other organization','UTC')",[]).run();
  await db.prepare(`INSERT INTO employees(id,org_id,employee_no,name,email,role) VALUES(
    'qa-other-employee','qa-other-org','OTHER','Other employee','other@walshken.test','employee')`,[]).run();
  await comm("directory-visibility",admin,{kind:"employee",target:"qa-other-employee",hidden:true},404);
  await check(admin,"qa-other-employee",404);
  assert.equal((await comm("oversight",admin,{section:"directory",query:"Other employee"})).directory.length,0);
  await comm("communication-support",admin,{department:"qa-support",enabled:false});
  assert.equal(await findMember(staff,support.id),false);
  await comm("send",staff,{conversation:supportConversation,body:"Support grant revoked"},403);
  assert.ok((await request("conversation/"+supportConversation,200,staff)).rows.length);
  console.log("PASS confirmation-only check, denied and confirmed starts, no department, additional departments, and explicit warning exemptions");
  console.log("PASS one-sided direct grants support replies, explicit deny blocks both sides, and removing the only grant revokes sending");
  console.log("PASS Support organization-wide search, both directions, group access, directory visibility, restoration, and no duplicate notices");
  console.log("PASS scoped Admin/HR/manager oversight, audited content, separate metadata, department and team filters, denied access, and cross-organization isolation");
  console.log("PASS removed members’ history stays scoped, reporting excludes mixed-scope activity, and suspended-only conversations are excluded");
}
