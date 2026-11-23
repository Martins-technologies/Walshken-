// Invoked by the isolated holiday route suite after it creates real payroll, leave and holiday records.
import assert from "node:assert/strict";

export async function verifyCalendar({ request, db, admin, staff, outsider, staffId, adminId, department, person, runId, defaultPolicy, localInstant }) {
  await request("view/calendar", 200, staff);
  process.env.WALSHKEN_CALENDAR_ENABLED = "1";
  process.env.WALSHKEN_TASKS_ENABLED = "1";
  process.env.WALSHKEN_TASK_DATASET = "preview";

  const manager = await person("manager", "Calendar team manager", "CAL-MGR-" + runId);
  const insert = async (sql, ...bindings) => db.prepare(sql, bindings).run();
  await insert("UPDATE employees SET manager_id=? WHERE id=?", manager.id, staffId);
  const zone = "America/Edmonton";
  const time = (day, wall) => localInstant(day + "T" + wall, zone);
  const shift = "calendar-overnight-" + runId;
  const start = time("2026-07-02", "22:00"), end = time("2026-07-03", "06:00");
  for (const [id, title, employee, state, stage] of [
    [shift, "Published overnight shift", staffId, "Published", "preview"],
    ["outside-" + shift, "Out-of-team shift", outsider.id, "Published", "preview"],
    ["draft-" + shift, "Unpublished shift", staffId, "Draft", "preview"],
    ["prod-" + shift, "Production-only shift", staffId, "Published", "production"],
  ]) await insert(`INSERT INTO shifts(id,org_id,employee_id,starts_at,ends_at,title,location,created_by,published,release_stage,workflow_version,state,time_zone,policy_snapshot)
    VALUES(?,'walshken',?,?,?,?,?,?,?, ?,1,?, ?,?)`, id, employee, start, end, title, "Calgary office", adminId, Number(state === "Published"), stage, state, zone, JSON.stringify(defaultPolicy()));

  const meeting = "calendar-meeting-" + runId;
  await insert(`INSERT INTO meetings(id,org_id,organizer_id,title,starts_at,ends_at,mode,provider)
    VALUES(?,'walshken',?,'Private client call',?,?,'Audio','livekit')`, meeting, staffId, time("2026-07-02", "15:00"), time("2026-07-02", "15:30"));
  await insert("INSERT INTO meeting_members(id,meeting_id,employee_id) VALUES(?,?,?)", "participant-" + meeting, meeting, staffId);

  const group = "calendar-group-" + runId;
  await insert("INSERT INTO conversations(id,org_id,title,kind,created_by,status) VALUES(?,'walshken','Calendar project group','Group',?,'Active')", group, manager.id);
  for (const member of [manager.id, staffId, outsider.id]) {
    await insert("INSERT INTO conversation_members(id,conversation_id,employee_id) VALUES(?,?,?)", group + member, group, member);
  }

  await insert(`INSERT INTO tasks(id,org_id,employee_id,assigned_by,title,description,priority,status,start_date,due_date,department_id,release_stage,workflow_version)
    VALUES(?,'walshken',?,?,'Review application','Sensitive client correspondence','High','In Progress','2026-07-01','2026-07-03',?,'preview',1)`,
  "calendar-task-" + runId, staffId, adminId, department);
  await insert(`INSERT INTO timesheets(id,org_id,employee_id,work_date,gross_seconds,unpaid_seconds,paid_seconds,status,release_stage,workflow_version,submitted_at)
    VALUES(?,'walshken',?,'2026-07-02',7200,0,7200,'Submitted','preview',1,?)`, "calendar-sheet-" + runId, staffId, time("2026-07-03", "10:00"));
  await insert(`INSERT INTO leave_requests(id,org_id,employee_id,category,starts_on,ends_on,status,note,release_stage)
    VALUES(?,'walshken',?,'Vacation','2026-07-03','2026-07-04','Pending','Private leave note','preview')`, "calendar-pending-" + runId, staffId);
  await insert(`INSERT INTO leave_requests(id,org_id,employee_id,category,starts_on,ends_on,status,release_stage)
    VALUES(?,'walshken',?,'Vacation','2026-07-09','2026-07-10','Approved','preview')`, "calendar-approved-" + runId, staffId);
  const draftPeriod = "calendar-draft-payroll-" + runId;
  await insert(`INSERT INTO payroll_periods(id,org_id,release_stage,label,frequency,starts_on,ends_on,pay_date,periods_per_year,created_by,created_at,updated_at)
    VALUES(?,'walshken','preview','Upcoming weekly period','Weekly','2026-07-20','2026-07-26','2026-07-30',52,?,?,?)`,
  draftPeriod, adminId, "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
  await insert("INSERT INTO payroll_members(id,org_id,release_stage,period_id,employee_id) VALUES(?,'walshken','preview',?,?)", "member-" + draftPeriod, draftPeriod, staffId);

  const get = async (user, query = "") => (await request("view/calendar?anchor=2026-07-01" + query, 200, user)).calendar;
  const personal = await get(staff);
  const entry = personal.entries.find(event => event.id === "shift:" + shift);
  assert.equal(personal.mode, "employee");
  assert.equal(entry.startDate, "2026-07-02");
  assert.equal(entry.endDate, "2026-07-03");
  assert.ok(personal.entries.some(event => event.title === "Review application" && event.status === "Due"));
  assert.ok(personal.entries.some(event => event.title === "Private client call" && event.status === "Audio call"));
  assert.ok(personal.entries.some(event => event.kind === "leave" && event.endDate === "2026-07-10"));
  assert.ok(personal.entries.some(event => event.kind === "statutory" && event.title === "Canada Day"));
  assert.ok(personal.entries.some(event => event.kind === "company" && event.title === "Authorized company general holiday"));
  assert.ok(personal.entries.some(event => event.kind === "payroll" && event.status === "Finalized"));
  assert.ok(!JSON.stringify(personal).includes(draftPeriod));
  assert.ok(!personal.entries.some(event => ["Unpublished shift", "Out-of-team shift", "Production-only shift", "Leave request"].includes(event.title)));
  await request("view/calendar?mode=admin", 403, staff);
  await request("view/calendar?mode=admin", 403, manager);
  await request("view/calendar?view=quarter", 400, staff);
  await request("view/calendar?from=2026-07-01&to=2026-11-01", 400, admin);

  const team = await get(manager, "&mode=manager&team=" + encodeURIComponent("group:" + group));
  assert.deepEqual(team.roster.map(person => person.id).sort(), [manager.id, staffId].sort());
  assert.ok(team.entries.some(event => event.kind === "busy" && event.title === "Busy" && !event.href));
  assert.ok(team.entries.some(event => event.title === "Timesheet approval"));
  assert.ok(team.entries.some(event => event.title === "Leave request"));
  assert.ok(team.entries.some(event => event.kind === "absence"));
  for (const secret of [meeting, "Private client call", "Sensitive client correspondence", "Private leave note", "Out-of-team shift", "Production-only shift", draftPeriod]) {
    assert.ok(!JSON.stringify(team).includes(secret), secret);
  }
  assert.deepEqual((await get(manager, "&employee=" + outsider.id)).entries, []);
  const organization = await get(admin, "&mode=admin&country=CA&department=" + department);
  assert.ok(organization.entries.some(event => event.title === "Out-of-team shift"));
  assert.ok(organization.entries.some(event => event.title === "Pay period closes" && event.startDate === "2026-07-26"));
  assert.ok(organization.entries.some(event => event.title === "Payroll payment date" && event.startDate === "2026-07-30"));
  const filtered = await get(manager, "&view=day&from=2026-07-03&to=2026-07-03&types=task&employee=" + staffId);
  assert.equal(filtered.from, "2026-07-03");
  assert.ok(filtered.entries.length && filtered.entries.every(event => event.kind === "task"));
  assert.ok(filtered.availability.some(item => item.person === staffId && item.status === "scheduled"));
  const fullWeek = (await request("view/calendar?view=week&anchor=2026-07-03", 200, staff)).calendar;
  assert.equal(fullWeek.from, "2026-06-29");
  assert.equal(fullWeek.to, "2026-07-05");
  await request("view/calendar", 401);
  console.log("PASS unified employee, manager and admin calendars, overnight dates, filters and source links, private meetings, availability and payroll isolation");
  return organization;
}
