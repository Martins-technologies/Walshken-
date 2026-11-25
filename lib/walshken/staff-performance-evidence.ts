import { AppError, all, fail, type Actor, type Db } from "./server";
import { dayAdd, localInstant } from "./attendance-rules";
import { employeeCompanyHolidays, holidayDataset, holidaysEnabled } from "./holiday-access";
import { applicableHolidays } from "./holiday-engine";
import { employmentPersonOn } from "./employment-engine";
import { taskDataset } from "./tasks";
import { localDate } from "./work";
import { workDataset } from "./workforce";
import type {
  ArrivalRecord, ArrivalStatus, ArrivalTotals, CompletionMetrics, PerformanceEmployee,
  PerformanceFactor, PerformanceModel, PerformancePerson,
} from "./staff-performance-types";

export type ReportEmployee = Actor & {
  designation: string;
  department: string | null;
  has_photo: boolean;
  hire_date: string | null;
  employment_end: string | null;
  created_at: string;
};
type Shift = { id: string; employee_id: string; starts_at: string; ends_at: string; time_zone: string; policy_snapshot: string; absence: string | null; excused: number | null };
type CheckIn = { id: string; employee_id: string; shift_id: string | null; starts_at: string; ends_at: string | null; source: string; approved: boolean };
type Leave = { employee_id: string; starts_on: string; ends_on: string };
type WorkItem = { id: string; employee_id: string; due_on: string | null; completed_at: string | null; time_zone?: string; assigned_at?: string; unassigned_at?: string | null };
type Assessment = { employee_id: string; month: string; review_score: number; quality_score: number | null };
type Calendar = { days: Set<string>; pending: boolean };
export type ReportSnapshot = { version: 1; month: string; model: PerformanceModel; employees: PerformanceEmployee[]; arrivals: ArrivalRecord[] };
export type Period = { month: string; start: string; end: string };
type Context = { employees: ReportEmployee[]; shifts: Shift[]; checkIns: CheckIn[]; leaves: Leave[]; tasks: WorkItem[];
  projects: WorkItem[]; milestones: WorkItem[]; assessments: Assessment[]; calendars: Map<string, Calendar> };

export function periodOf(month: string): Period {
  const start = month + "-01";
  const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10);
  return { month, start, end: dayAdd(next, -1) };
}

export function performanceClosed(period: Period, at: string) {
  // A calendar month is closed only after all worksite time zones have passed its final day.
  return at >= dayAdd(period.end, 1) + "T12:00:00.000Z";
}

export function reportPerson(employee: ReportEmployee): PerformancePerson {
  return { id: employee.id, name: employee.name, hasPhoto: employee.has_photo, department: employee.department ?? "Unassigned", departmentId: employee.department_id };
}

async function calendar(db: Db, employee: ReportEmployee, from: string, to: string): Promise<Calendar> {
  const days = new Set<string>();
  let pending = false;
  if (holidaysEnabled()) {
    for (const holiday of await employeeCompanyHolidays(db, employee, from, to)) if (holiday.closed) days.add(holiday.on_date);
    try {
      for (const holiday of await applicableHolidays(db, employee, from, to)) {
        if (holiday.required || holiday.closed) days.add(holiday.day);
      }
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 409) throw error;
      pending = true;
    }
    const paidDays = await all<{ day: string }>(db, `
      SELECT a.configuration::jsonb #>> '{facts,payDay}' AS day
      FROM holiday_assessments a WHERE a.org_id=? AND a.employee_id=? AND a.release_stage=? AND a.status='Approved'
      AND a.configuration::jsonb #>> '{facts,method}' <> 'Pay now'
      AND (a.configuration::jsonb #>> '{facts,payDay}') BETWEEN ? AND ?
      AND NOT EXISTS(SELECT 1 FROM holiday_assessments newer
        WHERE newer.org_id=a.org_id AND newer.release_stage=a.release_stage AND newer.employee_id=a.employee_id
        AND newer.holiday_date=a.holiday_date AND newer.status='Approved'
        AND (newer.created_at,newer.id)>(a.created_at,a.id))`,
      employee.org_id, employee.id, holidayDataset(), from, to);
    for (const { day } of paidDays) days.add(day);
  }
  const legacy = await all<{ day: string; jurisdiction: string }>(db, `
    SELECT on_date AS day,jurisdiction FROM holidays
    WHERE org_id=? AND release_stage=? AND cancelled_at IS NULL AND on_date BETWEEN ? AND ?`,
    employee.org_id, workDataset(), from, to);
  for (const h of legacy) {
    const assignment = await employmentPersonOn(db, employee, h.day);
    if (h.jurisdiction === assignment.jurisdiction) days.add(h.day);
  }
  return { days, pending };
}

const evidenceLimit = 60_000;
export async function performanceEvidence(db: Db, actor: Actor, employees: ReportEmployee[], from: string, to: string): Promise<Context> {
  const empty = { employees, shifts: [], checkIns: [], leaves: [], tasks: [], projects: [], milestones: [], assessments: [], calendars: new Map() };
  if (!employees.length) return empty;

  const ids = employees.map(employee => employee.id);
  const bounds = [dayAdd(from, -1) + "T00:00:00.000Z", dayAdd(to, 2) + "T00:00:00.000Z"];
  const stage = workDataset();
  const [shifts, checkIns, leaves, tasks, projects, milestones, assessments] = await Promise.all([
    all<Shift>(db, `SELECT s.id,s.employee_id,s.starts_at,s.ends_at,s.time_zone,s.policy_snapshot,
      x.status AS absence,x.manual_excuse AS excused
      FROM shifts s LEFT JOIN attendance_absences x ON x.shift_id=s.id AND x.employee_id=s.employee_id
        AND x.org_id=s.org_id AND x.release_stage=s.release_stage
      WHERE s.org_id=? AND s.release_stage=? AND s.employee_id=ANY(?::text[])
        AND s.workflow_version=1 AND s.state='Published' AND s.starts_at BETWEEN ? AND ?
      ORDER BY s.starts_at,s.id LIMIT 60001`, actor.org_id, stage, ids, ...bounds),
    all<CheckIn>(db, `SELECT a.id,a.employee_id,a.shift_id,a.starts_at,a.ends_at,a.source,
      EXISTS(SELECT 1 FROM timesheets t WHERE t.attendance_id=a.id AND t.org_id=a.org_id
        AND t.release_stage=a.release_stage AND t.employee_id=a.employee_id AND t.status='Approved') AS approved
      FROM attendance a WHERE a.org_id=? AND a.release_stage=? AND a.employee_id=ANY(?::text[])
        AND a.workflow_version=1 AND a.starts_at BETWEEN ? AND ?
      ORDER BY a.starts_at,a.id LIMIT 60001`, actor.org_id, stage, ids, ...bounds),
    all<Leave>(db, `SELECT employee_id,starts_on,ends_on FROM leave_requests
      WHERE org_id=? AND release_stage=? AND employee_id=ANY(?::text[]) AND status='Approved'
        AND starts_on<=? AND ends_on>=? LIMIT 60001`, actor.org_id, stage, ids, dayAdd(to, 1), from),
    all<WorkItem>(db, `SELECT t.id,t.employee_id,t.due_date AS due_on,t.completed_at,t.task_timezone AS time_zone FROM tasks t
      WHERE t.org_id=? AND t.release_stage=? AND t.employee_id=ANY(?::text[]) AND t.workflow_version=1 AND t.status<>'Cancelled'
        AND (t.due_date BETWEEN ? AND ? OR t.completed_at BETWEEN ? AND ?) LIMIT 60001`,
      actor.org_id, taskDataset(), ids, from, to, ...bounds),
    all<WorkItem>(db, `SELECT p.id,a.employee_id,p.due_on,p.completed_at,a.assigned_at,a.unassigned_at
      FROM project_assignments a JOIN projects p ON p.id=a.project_id AND p.org_id=a.org_id
      WHERE a.org_id=? AND a.employee_id=ANY(?::text[]) AND COALESCE(p.archived_from,p.status)<>'Cancelled'
        AND a.assigned_at<? AND (a.unassigned_at IS NULL OR a.unassigned_at>=?)
        AND (p.due_on BETWEEN ? AND ? OR p.completed_at BETWEEN ? AND ?) LIMIT 60001`,
      actor.org_id, ids, bounds[1], bounds[0], from, to, ...bounds),
    all<WorkItem>(db, `SELECT m.id,m.assignee_id AS employee_id,m.due_on,m.completed_at
      FROM project_milestones m JOIN projects p ON p.id=m.project_id
      WHERE p.org_id=? AND m.assignee_id=ANY(?::text[]) AND COALESCE(p.archived_from,p.status)<>'Cancelled'
        AND (m.due_on BETWEEN ? AND ? OR m.completed_at BETWEEN ? AND ?) LIMIT 60001`,
      actor.org_id, ids, from, to, ...bounds),
    all<Assessment>(db, `SELECT DISTINCT ON(a.employee_id,a.month) a.employee_id,a.month,a.review_score,a.quality_score
      FROM staff_performance_assessments a JOIN staff_performance_assessment_decisions d
        ON d.assessment_id=a.id AND d.org_id=a.org_id AND d.release_stage=a.release_stage
      WHERE a.org_id=? AND a.release_stage=? AND a.employee_id=ANY(?::text[]) AND a.month BETWEEN ? AND ?
        AND d.decision='Approved' ORDER BY a.employee_id,a.month,a.created_at DESC,a.id DESC LIMIT 60001`,
      actor.org_id, stage, ids, from.slice(0, 7), to.slice(0, 7)),
  ]);
  if ([shifts, checkIns, leaves, tasks, projects, milestones, assessments].some(rows => rows.length > evidenceLimit)) {
    return fail(413, "Narrow the report to a department or employee before requesting this volume of history.");
  }
  const calendars = new Map<string, Calendar>();
  const scheduled = new Set(shifts.map(shift => shift.employee_id));
  // Keep the number of live Postgres connections bounded on Preview.
  const calendarEmployees = employees.filter(employee => scheduled.has(employee.id));
  for (let start = 0; start < calendarEmployees.length; start += 8) {
    await Promise.all(calendarEmployees.slice(start, start + 8).map(async employee => {
      calendars.set(employee.id, await calendar(db, employee, from, dayAdd(to, 1)));
    }));
  }
  return { employees, shifts, checkIns, leaves, tasks, projects, milestones, assessments, calendars };
}

const timestamp = (value: string) => Date.parse(value);
const percent = (numerator: number, denominator: number) => denominator > 0 ? Math.round(numerator / denominator * 1000) / 10 : null;
function group<T extends { employee_id: string }>(items: T[]) {
  const byEmployee = new Map<string, T[]>();
  for (const item of items) {
    const records = byEmployee.get(item.employee_id) ?? [];
    records.push(item);
    byEmployee.set(item.employee_id, records);
  }
  return byEmployee;
}

function arrive(shift: Shift, checkIn: CheckIn | undefined, leaves: Leave[], calendar: Calendar | undefined, at: string): ArrivalRecord {
  const day = localDate(shift.starts_at, shift.time_zone);
  const lastDay = localDate(new Date(timestamp(shift.ends_at) - 1).toISOString(), shift.time_zone);
  const grace = (JSON.parse(shift.policy_snapshot) as { lateGrace?: number }).lateGrace ?? 0;
  const checkedIn = checkIn?.starts_at ?? null;
  const delta = checkedIn ? (timestamp(checkedIn) - timestamp(shift.starts_at)) / 60_000 : null;
  const record = (status: ArrivalStatus, reason: string): ArrivalRecord => ({
    id: shift.id, employeeId: shift.employee_id, day, scheduled: shift.starts_at, checkedIn,
    differenceMinutes: delta === null ? null : Math.round(delta * 10) / 10,
    graceMinutes: grace, timeZone: shift.time_zone, status, reason,
  });
  if (shift.excused === 1 || shift.absence === "Excused") return record("Excluded", "Excused scheduled shift");
  if (leaves.some(leave => leave.starts_on <= lastDay && leave.ends_on >= day)) return record("Excluded", "Approved leave");
  for (let cursor = day; cursor <= lastDay; cursor = dayAdd(cursor, 1)) {
    if (calendar?.days.has(cursor)) return record("Excluded", "Applicable holiday or company closure");
  }
  if (at < shift.starts_at && delta === null) return record("Upcoming", "Published shift has not started");
  if (calendar?.pending) return record("Pending", "Verify the assigned holiday calendar");
  if (checkIn && checkIn.source !== "Clock" && !checkIn.approved) return record("Pending", "Manual or corrected time awaits approval");
  if (delta !== null) {
    if (delta < 0) return record("Early", "Recorded check-in precedes the published start");
    if (delta > grace) return record("Late", "Recorded check-in exceeds the shift’s grace period");
    return record("On time", "Recorded check-in is within the shift’s grace period");
  }
  if (at < shift.ends_at) return record("Pending", "Scheduled shift has not ended");
  if (shift.absence === "No show") return record("Absent", "A no-show is recorded for this published shift");
  return record("Missing check-in", "No arrival or confirmed absence has been recorded");
}

function matchCheckIns(shifts: Shift[], checkIns: CheckIn[]) {
  const matches = new Map<string, CheckIn>();
  const linked = new Set(shifts.map(shift => shift.id));
  for (const checkIn of checkIns) {
    if (checkIn.shift_id && linked.has(checkIn.shift_id) && !matches.has(checkIn.shift_id)) matches.set(checkIn.shift_id, checkIn);
  }
  for (const checkIn of checkIns) {
    if (checkIn.shift_id) continue;
    let best: Shift | undefined;
    let closest = Number.POSITIVE_INFINITY;
    for (const shift of shifts) {
      if (matches.has(shift.id) || checkIn.starts_at >= shift.ends_at || (checkIn.ends_at && checkIn.ends_at <= shift.starts_at)) continue;
      const distance = Math.abs(timestamp(checkIn.starts_at) - timestamp(shift.starts_at));
      // Early unlinked arrivals use the same two-hour match window as the live clock.
      if (timestamp(checkIn.starts_at) + 7_200_000 < timestamp(shift.starts_at) || distance >= closest) continue;
      best = shift;
      closest = distance;
    }
    if (best) matches.set(best.id, checkIn);
  }
  return matches;
}

export function arrivalTotals(arrivals: ArrivalRecord[]): ArrivalTotals {
  let onTime = 0, early = 0, late = 0, absent = 0, missing = 0, pending = 0, upcoming = 0, excluded = 0;
  for (const record of arrivals) {
    if (record.status === "On time") onTime++;
    else if (record.status === "Early") early++;
    else if (record.status === "Late") late++;
    else if (record.status === "Absent") absent++;
    else if (record.status === "Missing check-in") missing++;
    else if (record.status === "Pending") pending++;
    else if (record.status === "Upcoming") upcoming++;
    else excluded++;
  }
  return summarizeAttendance({onTime,early,late,absent,missing,pending,upcoming,excluded});
}

export function summarizeAttendance(counts: Pick<ArrivalTotals, "onTime"|"early"|"late"|"absent"|"missing"|"pending"|"upcoming"|"excluded">): ArrivalTotals {
  const attended = counts.onTime + counts.early + counts.late;
  const expected = attended + counts.absent + counts.missing;
  return { ...counts, attended, expected, attendancePercent: percent(attended, expected), punctualityPercent: percent(counts.onTime + counts.early, attended) };
}

function assignmentIncludes(item: WorkItem, point: string) {
  return (!item.assigned_at || item.assigned_at <= point) && (!item.unassigned_at || item.unassigned_at > point);
}

function completion(items: WorkItem[], zone: string, period: Period, at: string): CompletionMetrics {
  const due = new Set<string>(), completed = new Set<string>(), completedThisMonth = new Set<string>();
  for (const item of items) {
    const itemZone = item.time_zone || zone;
    const completionDay = item.completed_at ? localDate(item.completed_at, itemZone) : null;
    const completedInScope = item.completed_at !== null && completionDay !== null && item.completed_at <= at
      && completionDay <= period.end && assignmentIncludes(item, item.completed_at);
    if (completedInScope && completionDay >= period.start) completedThisMonth.add(item.id);
    if (!item.due_on || item.due_on < period.start || item.due_on > period.end) continue;
    const cutoff = localInstant(dayAdd(item.due_on, 1) + "T00:00", itemZone);
    // Score completed work immediately and leave unfinished work outside the denominator until its deadline ends.
    if (!completedInScope && cutoff > at) continue;
    const dueInstant = new Date(timestamp(cutoff) - 1).toISOString();
    if (!completedInScope && !assignmentIncludes(item, dueInstant)) continue;
    due.add(item.id);
    if (completedInScope) completed.add(item.id);
  }
  return { due: due.size, completed: completed.size, completedThisMonth: completedThisMonth.size, percent: percent(completed.size, due.size) };
}

function indicators(row: Omit<PerformanceEmployee, "score"|"reason"|"measuredWeight"|"factors">, model: PerformanceModel) {
  const factors: PerformanceEmployee["factors"] = {
    attendance: row.attendance.attendancePercent, punctuality: row.attendance.punctualityPercent,
    tasks: row.tasks.percent, projects: row.projects.percent, milestones: row.milestones.percent,
    review: row.review, quality: row.quality,
  };
  let numerator = 0, measuredWeight = 0;
  for (const factor of Object.keys(model.weights) as PerformanceFactor[]) {
    const value = factors[factor];
    if (value !== null) {
      numerator += value * model.weights[factor];
      measuredWeight += model.weights[factor];
    }
  }
  const incompleteAttendance = (model.weights.attendance > 0 || model.weights.punctuality > 0)
    && (row.attendance.missing > 0 || row.attendance.pending > 0);
  const pendingAssessments = (model.weights.review > 0 && row.review === null) || (model.weights.quality > 0 && row.quality === null);
  const reason = incompleteAttendance ? "Scheduled arrival evidence is incomplete"
    : pendingAssessments ? "A configured assessment has not been approved"
    : measuredWeight === 0 ? "No qualifying evidence under the configured weights" : null;
  return { factors, measuredWeight, reason, score: reason ? null : Math.round(numerator / measuredWeight * 10) / 10 };
}

export function calculatePerformance(context: Context, period: Period, model: PerformanceModel, at: string): ReportSnapshot {
  const shifts = group(context.shifts), checkIns = group(context.checkIns), leaves = group(context.leaves),
    tasks = group(context.tasks), projects = group(context.projects), milestones = group(context.milestones);
  const assessed = new Map(context.assessments.filter(review => review.month === period.month).map(review => [review.employee_id, review]));
  const records = new Map<string, ArrivalRecord[]>();
  const employees = context.employees.filter(employee => {
    const hired = employee.hire_date || employee.created_at.slice(0, 10);
    return hired <= period.end && (!employee.employment_end || employee.employment_end >= period.start);
  }).map(employee => {
    const allShifts = shifts.get(employee.id) ?? [];
    const matches = matchCheckIns(allShifts, checkIns.get(employee.id) ?? []);
    const arrivals = allShifts.filter(shift => localDate(shift.starts_at, shift.time_zone).startsWith(period.month))
      .map(shift => arrive(shift, matches.get(shift.id), leaves.get(employee.id) ?? [], context.calendars.get(employee.id), at));
    records.set(employee.id, arrivals);
    const review = assessed.get(employee.id);
    const row = {
      id: employee.id, departmentId: employee.department_id, department: employee.department ?? "Unassigned",
      designation: employee.designation || "—", attendance: arrivalTotals(arrivals),
      tasks: completion(tasks.get(employee.id) ?? [], employee.time_zone, period, at),
      projects: completion(projects.get(employee.id) ?? [], employee.time_zone, period, at),
      milestones: completion(milestones.get(employee.id) ?? [], employee.time_zone, period, at),
      review: review?.review_score ?? null, quality: review?.quality_score ?? null,
    };
    return { ...row, ...indicators(row, model) };
  });
  return { version: 1, month: period.month, model, employees, arrivals: [...records.values()].flat() };
}
