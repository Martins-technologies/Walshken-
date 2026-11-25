import {policyDates,type EmploymentTerms} from "./employment-engine";
import { employmentEngineEnabled } from "./employment-catalog";
import { localInstant } from "./attendance-rules";
import { calendarTeams } from "./collaboration";
import { holidayDataset, holidaysEnabled, readRule } from "./holiday-access";
import { holidayDates } from "./canadian-calendars";
import type { CompanyHoliday, HolidayAssignment, HolidayRule } from "./holiday-types";
import { payScope, payrollDataset, payrollEnabled } from "./payroll-access";
import { all, canManage, canPayroll, date, fail, json, now, requireStaff, scope, str, type Actor, type Db } from "./server";
import { calendarBounds, calendarDay, calendarTypes, type CalendarEntry, type CalendarKind, type CalendarMode, type CalendarOption, type CalendarPerson, type CalendarView, type StaffCalendarData } from "./staff-calendar-types";
import { taskDataset, tasksEnabled } from "./tasks";
import { localDate } from "./work";
import { policyAdmin, workDataset, workforceEnabled } from "./workforce";

export const staffCalendarEnabled = () => process.env.WALSHKEN_CALENDAR_ENABLED === "1";

type Person = CalendarPerson & { departmentName: string | null; managerName: string | null; jurisdiction: string; hireDate: string | null; endDate: string | null; active: boolean };
type Timed = { id: string; title: string; starts_at: string; ends_at: string; employee_id: string };
type Leave = { id: string; employee_id: string; starts_on: string; ends_on: string; category: string; status: string; note: string | null };
type DateRow = { id: string; employee_id: string; work_date: string; status: string };
const ids = "SELECT jsonb_array_elements_text(?::jsonb)";
const link = (path: string, values: Record<string, string> = {}) => "/staff/" + path + (Object.keys(values).length ? "?" + new URLSearchParams(values) : "");
const timedDay = (stamp: string, zone: string) => localDate(stamp, zone);
const unique = <T>(values: T[]) => [...new Set(values)];
const rangeLimit = 92 * 86_400_000;
// Some time zones move clocks forward at midnight. Find the first instant of that local day if midnight is skipped.
function dayBoundary(day: string, zone: string) {
  try {
    return localInstant(day + "T00:00", zone);
  } catch {
    const noon = Date.parse(day + "T12:00:00Z");
    let low = noon - 36 * 3_600_000, high = noon + 36 * 3_600_000;
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (localDate(new Date(mid).toISOString(), zone) < day) low = mid;
      else high = mid;
    }
    return new Date(high).toISOString();
  }
}
const approvalRoles = ["super_admin", "admin", "hr"];

async function peopleInScope(db: Db, actor: Actor, allowed: { sql: string; args: unknown[] }) {
  return all<Person>(db, `SELECT e.id,e.name,e.country,e.jurisdiction,e.department_id AS "departmentId",e.manager_id AS "managerId",
    d.name AS "departmentName",m.name AS "managerName",e.hire_date AS "hireDate",e.employment_end AS "endDate",
    (e.status='Active' AND e.employment_status<>'Ended') AS active
    FROM employees e LEFT JOIN units d ON d.id=e.department_id AND d.org_id=e.org_id
    LEFT JOIN employees m ON m.id=e.manager_id AND m.org_id=e.org_id
    WHERE e.org_id=? AND e.role<>'guest' AND ${allowed.sql} ORDER BY e.name,e.id`, actor.org_id, ...allowed.args);
}

function options(people: Person[], key: "departmentId" | "managerId", name: "departmentName" | "managerName") {
  return [...new Map(people.flatMap(person => {
    const id = person[key], label = person[name];
    return id && label ? [[id, { id, name: label }] as const] : [];
  })).values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function holidayEntries(db: Db, actor: Actor, people: Person[], from: string, to: string, geographyOn: (person:Person,day:string)=>Pick<Person,"jurisdiction">) {
  const entries: CalendarEntry[] = [];
  const computed = new Map<string, Map<string, ReturnType<typeof holidayDates>[number]>>();
  if (!holidaysEnabled() || !people.length) return { entries, missing: 0 };
  const allPeople=people;
  const dynamicStarts=new Map<string,string>();
  const dynamicHolidays=new Map<string,CalendarEntry>();
  let dynamicMissing=0;
  if(employmentEngineEnabled())for(const person of people){
    const starts=person.hireDate&&person.hireDate>from?person.hireDate:from;
    const ends=person.endDate&&person.endDate<to?person.endDate:to;
    if(starts>ends)continue;
    const calendar=await policyDates(db,{id:person.id,org_id:actor.org_id},starts,ends);
    if(!calendar.configured)continue;
    dynamicStarts.set(person.id,calendar.startsOn??starts);
    if(calendar.pending)dynamicMissing++;
    for(const day of calendar.dates.filter(day=>day.required)){
      const id='policy-holiday:'+day.policyId+':'+day.day;
      const entry=dynamicHolidays.get(id)??{id,kind:"statutory",title:day.name,startDate:day.day,endDate:day.day,people:[],status:geographyOn(person,day.day).jurisdiction};
      entry.people.push(person.id);
      dynamicHolidays.set(id,entry);
    }
  }
  entries.push(...dynamicHolidays.values());
  people=people.filter(person=>!dynamicStarts.has(person.id)||dynamicStarts.get(person.id)!>from);
  const stage = holidayDataset();
  const [assignments, ruleRows, company] = await Promise.all([
    all<HolidayAssignment>(db, `SELECT * FROM holiday_assignments WHERE org_id=? AND release_stage=? AND effective_on<=?
      AND employee_id IN(${ids}) ORDER BY effective_on DESC,created_at DESC,id DESC`, actor.org_id, stage, to, JSON.stringify(people.map(person => person.id))),
    all<HolidayRule>(db, `SELECT * FROM holiday_rules WHERE org_id=? AND release_stage=? AND effective_from<=? AND effective_through>=?
      ORDER BY effective_from DESC,created_at DESC,id DESC`, actor.org_id, stage, to, from),
    all<Pick<CompanyHoliday, "id" | "name" | "kind" | "closed" | "jurisdiction" | "on_date" | "targets">>(db,
      "SELECT id,name,kind,closed,jurisdiction,on_date,targets FROM holiday_company_events WHERE org_id=? AND release_stage=? AND cancelled_at IS NULL AND on_date BETWEEN ? AND ?",
      actor.org_id, stage, from, to),
  ]);
  const assigned = new Map<string, HolidayAssignment[]>();
  for (const assignment of assignments) {
    const list = assigned.get(assignment.employee_id) ?? [];
    list.push(assignment);
    assigned.set(assignment.employee_id, list);
  }
  const rules = ruleRows.map(row => ({ row, calendar: readRule(row).calendar }));
  const holidays = new Map<string, CalendarEntry>();
  let missing = 0;
  for (const person of people) {
    const own = assigned.get(person.id) ?? [];
    const applies = (day: string) => (!person.hireDate || day >= person.hireDate) && (!person.endDate || day <= person.endDate);
    const assignmentOnDay = (day: string) => own.find(row => row.effective_on <= day);
    if (person.active && !dynamicStarts.has(person.id) && person.country === "CA" && assignmentOnDay(to)?.jurisdiction !== person.jurisdiction) missing++;
    for (let day = from; day <= to; day = calendarDay(day, 1)) {
      const year = Number(day.slice(0, 4));
      if ((dynamicStarts.has(person.id)&&day>=dynamicStarts.get(person.id)!) || !applies(day) || year < 2026 || year > 2028) continue;
      const assignment = assignmentOnDay(day);
      if (!assignment || assignment.jurisdiction !== geographyOn(person,day).jurisdiction) continue;
      const legal = rules.find(rule => rule.row.jurisdiction === assignment.jurisdiction && rule.row.effective_from <= day && rule.row.effective_through >= day);
      if (!legal) continue;
      const holiday = calendarForYear(legal.calendar, year, assignment.easter_choice).get(day);
      if (!holiday) continue;
      const id = `statutory:${assignment.jurisdiction}:${day}:${holiday.key}`;
      const entry = holidays.get(id) ?? { id, kind: "statutory", title: holiday.name, startDate: day, endDate: day, status: assignment.jurisdiction, people: [], href: link("holiday-calendar") };
      entry.people.push(person.id);
      holidays.set(id, entry);
    }
  }
  entries.push(...holidays.values());
  const roster = new Map(allPeople.map(person => [person.id, person]));
  for (const event of company) {
    const targets = (JSON.parse(event.targets) as string[]).filter(id => {
      const person = roster.get(id);
      return person && geographyOn(person,event.on_date).jurisdiction === event.jurisdiction && (!person.hireDate || event.on_date >= person.hireDate)
        && (!person.endDate || event.on_date <= person.endDate);
    });
    if (targets.length) entries.push({ id: "company:" + event.id, kind: "company", title: event.name, startDate: event.on_date,
      endDate: event.on_date, people: targets, status: event.closed ? "Company closure" : event.kind, href: link("holiday-calendar") });
  }
  return { entries, missing:missing+dynamicMissing };

  function calendarForYear(calendar: ReturnType<typeof readRule>["calendar"], year: number, easter: string) {
    const key = calendar.code + ":" + calendar.version + ":" + year + ":" + easter;
    const existing = computed.get(key);
    if (existing) return existing;
    const result = new Map(holidayDates(calendar, year, easter).filter(holiday => holiday.status === "Statutory").map(holiday => [holiday.date, holiday]));
    computed.set(key, result);
    return result;
  }
}


export async function staffCalendar(db: Db, actor: Actor, params: URLSearchParams) {
  requireStaff(actor);
  const management = canManage(actor);
  const admin = approvalRoles.includes(actor.role);
  const modes: CalendarMode[] = ["employee", ...(management ? ["manager" as const] : []), ...(admin ? ["admin" as const] : [])];
  const requested = params.get("mode") ?? (admin ? "admin" : management ? "manager" : "employee");
  if (!modes.includes(requested as CalendarMode)) return fail(403, "This calendar view is outside your role.");
  const mode = requested as CalendarMode;
  const personal = mode === "employee";
  const today = localDate(now(), actor.time_zone);
  const view = (params.get("view") ?? "month") as CalendarView;
  if (!["day", "week", "month"].includes(view)) return fail(400, "Choose a day, week or month view.");
  const dateValue = (value: string, label: string) => {
    const day = date(value, label)!;
    if (day < "1900-01-01" || day > "2199-12-31") return fail(400, "Choose a calendar date from 1900 through 2199.");
    return day;
  };
  const customRange = params.has("from") || params.has("to");
  const anchor = dateValue(params.get("anchor") ?? params.get("from") ?? today, "calendar date");
  const { from, to } = customRange
    ? { from: dateValue(params.get("from") ?? "", "range start"), to: dateValue(params.get("to") ?? "", "range end") }
    : calendarBounds(anchor, view);
  if (to < from || Date.parse(to) - Date.parse(from) > rangeLimit) return fail(400, "Choose an ordered range of up to 93 days.");
  const filter = (key: string) => str(params.get(key), key, 100, false);
  const kinds = unique((params.get("types") ?? "").split(",").filter(Boolean)) as CalendarKind[];
  if (kinds.some(kind => !Object.hasOwn(calendarTypes, kind))) return fail(400, "Choose a supported calendar event type.");
  const filters = { department: filter("department"), country: filter("country"),region:filter("region"),jurisdiction:filter("jurisdiction"), employee: filter("employee"), team: filter("team"), kinds };
  const scoped = personal ? { sql: "e.id=?", args: [actor.id] } : scope(actor);
  const payrollManagement = mode === "admin" && canPayroll(actor) && payrollEnabled();
  let [people, payrollPeople, groups] = await Promise.all([
    peopleInScope(db, actor, scoped),
    payrollManagement ? payScope(db, actor).then(allowed => peopleInScope(db, actor, allowed)) : Promise.resolve([]),
    personal ? Promise.resolve([]) : calendarTeams(db, actor),
  ]);
  const scopedPeople=[...new Map([...people,...payrollPeople].map(person=>[person.id,person])).values()];
  const histories=new Map<string,EmploymentTerms[]>();
  const possibleDays=new Set([from]);
  const historyThrough=anchor>to?anchor:to,historyFrom=anchor<from?anchor:from;
  if(employmentEngineEnabled()&&scopedPeople.length){
    const terms=await all<EmploymentTerms>(db,`SELECT t.* FROM staff_employment_terms t WHERE t.org_id=? AND t.employee_id IN(${ids}) AND t.effective_on<=?
      AND (t.effective_on>=? OR t.effective_on=(SELECT MAX(prior.effective_on) FROM staff_employment_terms prior
      WHERE prior.org_id=t.org_id AND prior.employee_id=t.employee_id AND prior.effective_on<?))
      ORDER BY t.effective_on DESC`,actor.org_id,JSON.stringify(scopedPeople.map(person=>person.id)),historyThrough,historyFrom,historyFrom);
    for(const row of terms){
      const history=histories.get(row.employee_id)??[];
      history.push(row);histories.set(row.employee_id,history);
      if(row.effective_on>=from&&row.effective_on<=to)possibleDays.add(row.effective_on);
    }
  }
  const scopedPeopleById=new Map(scopedPeople.map(person=>[person.id,person]));
  const geographyOn=(person:Person,day:string)=>{
    const fallback=scopedPeopleById.get(person.id)??person,terms=histories.get(person.id)?.find(row=>row.effective_on<=day);
    return {country:terms?.country??fallback.country,region:terms?.region_code??fallback.jurisdiction,jurisdiction:terms?.jurisdiction??fallback.jurisdiction};
  };
  const visible=scopedPeople.map(person=>({...person,...geographyOn(person,anchor)}));
  const dateGeography=scopedPeople.flatMap(person=>[...possibleDays].map(day=>geographyOn(person,day)));
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const countries: CalendarOption[] = unique(dateGeography.map(person => person.country)).filter(code => /^[A-Z]{2}$/.test(code))
    .map(id => ({ id, name: id === "ZZ" ? "Unassigned country" : names.of(id) ?? id })).sort((left, right) => left.name.localeCompare(right.name));
  const departments = options(visible, "departmentId", "departmentName");
  const visibleIds = new Set(visible.map(person => person.id));
  const visibleGroups = groups.filter(group => group.members.some(id => visibleIds.has(id)));
  const teams = [
    ...options(visible, "managerId", "managerName").map(team => ({ ...team, name: team.name + "’s team" })),
    ...visibleGroups.map(group => ({ id: "group:" + group.id, name: group.name })),
  ];
  const groupMembers = filters.team.startsWith("group:")
    ? new Set(visibleGroups.find(group => "group:" + group.id === filters.team)?.members ?? []) : null;
  const matchGeography=(person:Person,day:string)=>{
    const geo=geographyOn(person,day);
    return (!filters.country||filters.country===geo.country)&&(!filters.region||filters.region===geo.region)
      &&(!filters.jurisdiction||filters.jurisdiction===geo.jurisdiction);
  };
  const commonMatch = (person: Person) => (!filters.employee || filters.employee === person.id)
    && [...possibleDays].some(day=>matchGeography(person,day))
    && (!filters.team || (groupMembers ? groupMembers.has(person.id) : filters.team === person.managerId || filters.team === person.id));
  const matches = (person: Person) => commonMatch(person) && (!filters.department || filters.department === person.departmentId);
  const selected = people.filter(matches);
  const taskPeople = people.filter(commonMatch);
  const payrollRoster = (payrollManagement ? payrollPeople : personal ? people : []).filter(matches);
  const rosterJson = JSON.stringify(selected.map(person => person.id));
  const start = dayBoundary(from, actor.time_zone);
  const end = dayBoundary(calendarDay(to, 1), actor.time_zone);
  const stage = workDataset();
  const records = workforceEnabled() && selected.length > 0;
  const requestedType = (...types: CalendarKind[]) => kinds.length === 0 || types.some(type => kinds.includes(type));
  const [shifts, tasks, meetings, leave, absences, sheets, corrections, swaps, paydays, holidays, taskDepartments] = await Promise.all([
    records ? all<Timed & { location: string; state: string }>(db, `SELECT s.id,s.title,s.starts_at,s.ends_at,s.employee_id,s.location,s.state
      FROM shifts s WHERE s.org_id=? AND s.release_stage=? AND s.workflow_version=1 AND s.state IN ('Published'${personal ? "" : ",'Draft'"})
      AND s.starts_at<? AND s.ends_at>? AND s.employee_id IN(${ids})`, actor.org_id, stage, end, start, rosterJson) : [],
    tasksEnabled() && taskPeople.length && requestedType("task", "approval") ? all<{ id: string; title: string; employee_id: string; start_date: string | null; due_date: string | null; status: string; approval_status: string; reviewer_id: string | null; submitted_at: string | null }>(db,
      `SELECT t.id,t.title,t.employee_id,t.start_date,t.due_date,t.status,t.approval_status,t.reviewer_id,t.submitted_at
      FROM tasks t JOIN employees e ON e.id=t.employee_id AND e.org_id=t.org_id WHERE t.org_id=? AND t.release_stage=? AND t.workflow_version=1
      AND t.status<>'Cancelled' AND t.employee_id IN(${ids}) AND (?='' OR COALESCE(t.department_id,e.department_id)=?)
      AND (t.start_date BETWEEN ? AND ? OR t.due_date BETWEEN ? AND ? OR (t.approval_status='Pending' AND t.submitted_at>=? AND t.submitted_at<?))`,
      actor.org_id, taskDataset(), JSON.stringify(taskPeople.map(person => person.id)), filters.department, filters.department,
      from, to, from, to, start, end) : [],
    selected.length ? all<Timed & { visible: boolean; mode: string; ended_at: string | null }>(db, `SELECT m.id,
      CASE WHEN mine.employee_id IS NOT NULL THEN m.title ELSE '' END AS title, mine.employee_id IS NOT NULL AS visible,
      CASE WHEN mine.employee_id IS NOT NULL THEN m.mode ELSE '' END AS mode,m.starts_at,m.ends_at,m.ended_at,p.employee_id
      FROM meetings m JOIN meeting_members p ON p.meeting_id=m.id AND p.removed_at IS NULL
      LEFT JOIN meeting_members mine ON mine.meeting_id=m.id AND mine.employee_id=? AND mine.removed_at IS NULL
      WHERE m.org_id=? AND m.provider='livekit' AND m.cancelled_at IS NULL AND m.starts_at<? AND m.ends_at>?
      AND p.employee_id IN(${ids})`, actor.id, actor.org_id, end, start, rosterJson) : [],
    records ? all<Leave>(db, `SELECT id,employee_id,starts_on,ends_on,category,status,note FROM leave_requests
      WHERE org_id=? AND release_stage=? AND status IN ('Approved'${personal ? "" : ",'Pending'"}) AND starts_on<=? AND ends_on>=?
      AND employee_id IN(${ids})`, actor.org_id, stage, to, from, rosterJson) : [],
    records && !personal ? all<Timed & { status: string }>(db, `SELECT a.id,a.employee_id,s.starts_at,s.ends_at,a.status
      FROM attendance_absences a JOIN shifts s ON s.id=a.shift_id AND s.org_id=a.org_id AND s.release_stage=a.release_stage
      WHERE a.org_id=? AND a.release_stage=? AND a.status IN ('No show','Absent','Excused','Sick leave')
      AND s.starts_at<? AND s.ends_at>? AND a.employee_id IN(${ids})`, actor.org_id, stage, end, start, rosterJson) : [],
    records && !personal && requestedType("approval") ? all<DateRow & { submitted_at: string | null }>(db,
      `SELECT id,employee_id,work_date,status,submitted_at FROM timesheets WHERE org_id=? AND release_stage=? AND workflow_version=1
      AND status='Submitted' AND employee_id<>? AND employee_id IN(${ids})
      AND (work_date BETWEEN ? AND ? OR submitted_at>=? AND submitted_at<?)`, actor.org_id, stage, actor.id, rosterJson, from, to, start, end) : [],
    records && !personal && policyAdmin(actor) && requestedType("approval") ? all<DateRow & { requested_at: string }>(db,
      `SELECT c.id,c.employee_id,left(c.proposed_start,10) AS work_date,c.status,c.created_at AS requested_at
      FROM corrections c JOIN attendance a ON a.id=c.attendance_id AND a.release_stage=c.release_stage AND a.employee_id=c.employee_id
      WHERE a.org_id=? AND c.release_stage=? AND c.status='Pending' AND c.employee_id<>? AND c.requested_by<>?
      AND c.employee_id IN(${ids}) AND c.created_at>=? AND c.created_at<?`, actor.org_id, stage, actor.id, actor.id, rosterJson, start, end) : [],
    records && !personal && requestedType("approval") ? all<Timed & { partner_id: string }>(db,
      `SELECT x.id,x.requester_id AS employee_id,x.partner_id,s.starts_at,s.ends_at,s.title FROM shift_swaps x
      JOIN shifts s ON s.id=x.source_shift AND s.org_id=x.org_id AND s.release_stage=x.release_stage
      WHERE x.org_id=? AND x.release_stage=? AND x.status='Pending approval' AND x.requester_id<>? AND x.partner_id<>?
      AND x.requester_id IN(${ids}) AND x.partner_id IN(${ids}) AND s.starts_at<? AND s.ends_at>?`,
      actor.org_id, stage, actor.id, actor.id, rosterJson, JSON.stringify(people.map(person => person.id)), end, start) : [],
    payrollEnabled() && payrollRoster.length && requestedType("payroll") ? all<{ id: string; employee_id: string; pay_date: string; ends_on: string; status: string; label: string }>(db,
      `SELECT p.id,m.employee_id,p.pay_date,p.ends_on,p.status,p.label FROM payroll_periods p JOIN payroll_members m ON m.period_id=p.id AND m.org_id=p.org_id AND m.release_stage=p.release_stage
      WHERE p.org_id=? AND p.release_stage=? AND p.status<>'Cancelled'
      AND m.employee_id IN(${ids}) AND (p.pay_date BETWEEN ? AND ? OR (?=1 AND p.ends_on BETWEEN ? AND ?))
      AND (?=1 OR EXISTS(SELECT 1 FROM payroll r WHERE r.period_id=p.id AND r.employee_id=m.employee_id AND r.release_stage=p.release_stage
        AND r.org_id=p.org_id AND r.workflow_version=1 AND r.status='Finalized'))`,
      actor.org_id, payrollDataset(), JSON.stringify(payrollRoster.map(person => person.id)), from, to, payrollManagement ? 1 : 0, from, to, payrollManagement ? 1 : 0) : [],
    holidayEntries(db, actor, selected, from, to, geographyOn),
    tasksEnabled() && people.length ? all<CalendarOption>(db, `SELECT DISTINCT u.id,u.name FROM tasks t
      JOIN units u ON u.id=t.department_id AND u.org_id=t.org_id AND u.kind='Department'
      WHERE t.org_id=? AND t.release_stage=? AND t.workflow_version=1 AND t.status<>'Cancelled'
      AND t.employee_id IN(${ids})`, actor.org_id, taskDataset(), JSON.stringify(people.map(person => person.id))) : [],
  ]);
  const entries: CalendarEntry[] = [...holidays.entries];
  const appendDate = (id: string, kind: CalendarKind, title: string, day: string, people: string[], status?: string, href?: string, endDate = day) => {
    if (day <= to && endDate >= from) entries.push({ id, kind, title, startDate: day, endDate, people, status, href });
  };
  const appendTimed = (id: string, kind: CalendarKind, title: string, startsAt: string, endsAt: string, people: string[], status?: string, href?: string, location?: string) => {
    const endDate = timedDay(new Date(Math.max(Date.parse(startsAt), Date.parse(endsAt) - 1)).toISOString(), actor.time_zone);
    entries.push({ id, kind, title, startDate: timedDay(startsAt, actor.time_zone), endDate, startsAt, endsAt, people, status, href, location });
  };
  const schedule = personal ? "shifts" : "scheduling";
  for (const row of shifts) appendTimed("shift:" + row.id, "shift", row.title, row.starts_at, row.ends_at, [row.employee_id],
    row.state, link(schedule, { from, to }), row.location);
  for (const task of tasks) {
    const href = link("tasks", { task: task.id });
    if (task.start_date && task.start_date !== task.due_date) appendDate("start:" + task.id, "task", task.title, task.start_date, [task.employee_id], "Starts", href);
    if (task.due_date) appendDate("due:" + task.id, "task", task.title, task.due_date, [task.employee_id], task.status === "Completed" ? "Completed" : "Due", href);
    if (!personal && task.approval_status === "Pending" && task.submitted_at)
      appendDate("review:" + task.id, "approval", task.title, timedDay(task.submitted_at, actor.time_zone), [task.employee_id],
        task.reviewer_id === actor.id ? "Your task review" : "Task review pending", href);
  }
  const meetingRows = new Map<string, CalendarEntry>();
  for (const meeting of meetings) {
    const endsAt = meeting.ended_at ? new Date(Math.min(Date.parse(meeting.ended_at), Date.parse(meeting.ends_at))).toISOString() : meeting.ends_at;
    if (endsAt <= start || endsAt <= meeting.starts_at) continue;
    if (!meeting.visible) {
      // The roster can show a busy interval, while the meeting ID, title and membership remain private.
      const anonymousKey = "busy:" + meeting.employee_id + ":" + meeting.starts_at + ":" + endsAt;
      if (!meetingRows.has(anonymousKey)) {
        appendTimed(anonymousKey, "busy", "Busy", meeting.starts_at, endsAt, [meeting.employee_id], "Private commitment");
        meetingRows.set(anonymousKey, entries.at(-1)!);
      }
      continue;
    }
    const id = "meeting:" + meeting.id;
    const existing = meetingRows.get(id);
    if (existing) existing.people.push(meeting.employee_id);
    else {
      appendTimed(id, "meeting", meeting.title, meeting.starts_at, endsAt, [meeting.employee_id],
        meeting.mode === "Audio" ? "Audio call" : "Video meeting", link("calls", { meeting: meeting.id }));
      meetingRows.set(id, entries.at(-1)!);
    }
  }
  for (const row of leave) {
    const own = row.employee_id === actor.id;
    if (row.note?.startsWith("Company closure · ")) continue;
    if (row.status === "Approved") {
      const substitute = row.note?.startsWith("Holiday paid day · ");
      appendDate("leave:" + row.id, substitute ? "company" : "leave", substitute ? "Paid substitute holiday" : own ? row.category : "Approved leave",
        row.starts_on, [row.employee_id], "Approved", link(substitute ? "holiday-calendar" : "leave", substitute ? {} : { from, to, team: personal ? "0" : "1" }), row.ends_on);
    } else {
      appendDate("leave-review:" + row.id, "approval", "Leave request", row.starts_on, [row.employee_id], "Awaiting approval",
        link("leave", { from, to, team: "1" }), row.ends_on);
    }
  }
  for (const row of absences) appendTimed("absence:" + row.id, "absence", "Staff absence", row.starts_at, row.ends_at, [row.employee_id],
    row.status === "Sick leave" ? "Approved absence" : row.status, link("scheduling", { from, to }));
  for (const row of sheets) {
    const submitted = row.submitted_at ? timedDay(row.submitted_at, actor.time_zone) : row.work_date;
    const shownOn = submitted >= from && submitted <= to ? submitted : row.work_date;
    appendDate("timesheet:" + row.id, "approval", "Timesheet approval", shownOn, [row.employee_id],
      "Work date " + row.work_date, link("approvals", { from: row.work_date, to: row.work_date }));
  }
  for (const row of corrections) appendDate("correction:" + row.id, "approval", "Attendance correction",
    timedDay(row.requested_at, actor.time_zone), [row.employee_id], "Awaiting approval", link("approvals", { from, to }));
  for (const row of swaps) appendDate("swap:" + row.id, "approval", "Shift swap request", timedDay(row.starts_at, actor.time_zone),
    [row.employee_id, row.partner_id].filter(id => selected.some(person => person.id === id)), "Awaiting approval", link("scheduling", { from, to }));
  const payrollEvents = new Map<string, CalendarEntry>();
  for (const row of paydays) {
    const dates = [{ suffix: "pay", day: row.pay_date, title: payrollManagement ? "Payroll payment date" : "Payday" }];
    if (payrollManagement) dates.push({ suffix: "close", day: row.ends_on, title: "Pay period closes" });
    for (const item of dates) {
      if (item.day < from || item.day > to) continue;
      const id = "payroll:" + row.id + ":" + item.suffix;
      const existing = payrollEvents.get(id);
      if (existing) existing.people.push(row.employee_id);
      else {
        appendDate(id, "payroll", item.title, item.day, [row.employee_id], payrollManagement ? row.label + " · " + row.status : "Finalized",
          link(payrollManagement ? "payroll" : "salary", { period: row.id }));
        payrollEvents.set(id, entries.at(-1)!);
      }
    }
  }
  const filteredEntries=entries.map(entry=>{
    if(!filters.country&&!filters.region&&!filters.jurisdiction)return entry;
    const startDate=entry.startDate>from?entry.startDate:from,endDate=entry.endDate<to?entry.endDate:to;
    const checkDays=[startDate,...[...possibleDays].filter(day=>day>startDate&&day<=endDate)];
    return {...entry,people:entry.people.filter(person=>{
      const scopedPerson=scopedPeopleById.get(person);
      return scopedPerson&&checkDays.some(day=>matchGeography(scopedPerson,day));
    })};
  }).filter(entry=>entry.people.length);
  const availabilityStatus: Partial<Record<CalendarKind, string>> = {
    shift: "scheduled", leave: "time off", absence: "absence recorded", busy: "meeting scheduled", meeting: "meeting scheduled",
  };
  const availability = personal ? [] : filteredEntries.flatMap(entry => {
    const status = entry.status === "Draft" ? undefined : availabilityStatus[entry.kind]
      ?? (entry.kind === "company" && (entry.status === "Company closure" || entry.title === "Paid substitute holiday") ? "time off" : undefined);
    return status ? entry.people.map(person => ({ person, status, from: entry.startDate, to: entry.endDate })) : [];
  });
  const publicPerson = ({ id, name, country,region,jurisdiction, departmentId, managerId }: Person): CalendarPerson => ({ id, name, country,region,jurisdiction, departmentId, managerId });
  const effectiveRoster=(person:Person)=>({...person,...geographyOn(person,anchor)});
  const data: StaffCalendarData = {
    mode, modes, view, anchor, today, from, to, customRange, zone: actor.time_zone, filters,
    options: {
      people: visible.map(publicPerson),
      departments: [...new Map([...departments, ...taskDepartments].map(department => [department.id, department])).values()]
        .sort((left, right) => left.name.localeCompare(right.name)),
      countries,teams,regions:unique(dateGeography.map(person=>person.region).filter(Boolean)).map(code=>({id:code!,name:code!})),
      jurisdictions:unique(dateGeography.map(person=>person.jurisdiction).filter(Boolean)).map(code=>({id:code,name:code})),
    },
    roster: selected.filter(person => person.active || person.endDate && person.endDate >= from).map(person => ({ ...publicPerson(effectiveRoster(person)), from: person.hireDate, to: person.endDate })),
    availability,
    entries: filteredEntries.filter(entry=>requestedType(entry.kind))
      .sort((left, right) => left.startDate.localeCompare(right.startDate) || (left.startsAt ?? "").localeCompare(right.startsAt ?? "") || left.title.localeCompare(right.title) || left.id.localeCompare(right.id)),
    holidaySetupNeeded: holidays.missing,
  };
  return json({ managedCalendar: true, calendar: data });
}
