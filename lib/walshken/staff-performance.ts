import { createHash } from "node:crypto";
import { actionScope, hasAction, requireEmployeeAction } from "./staff-authority";
import { all, audit, canSuper, fail, id, integer, now, one, pick, requireStaff, run, str, type Actor, type Db } from "./server";
import { localDate } from "./work";
import { workDataset } from "./workforce";
import {
  calculatePerformance, performanceClosed, performanceEvidence, periodOf, reportPerson, summarizeAttendance,
  type Period, type ReportEmployee, type ReportSnapshot,
} from "./staff-performance-evidence";
import {
  arrivalStatuses, performanceFactors, type CompletionMetrics, type PerformanceAssessment,
  type PerformanceEmployee, type PerformanceFactor, type PerformanceModel, type PerformancePage,
  type PerformancePerson, type PerformanceWeights, type RankedEmployee,
} from "./staff-performance-types";

export const performanceEnabled = () => process.env.WALSHKEN_MANAGEMENT_REPORTS_ENABLED === "1";
const baseline: PerformanceWeights = { attendance: 35, punctuality: 30, tasks: 20, projects: 5, milestones: 10, review: 0, quality: 0 };
const pageSize = 25;
type Saved = { month: string; snapshot: string; snapshot_hash: string; finalized_at: string };
type Model = { id: string; effective_month: string; weights: PerformanceWeights };
type Privilege = "performance.read" | "performance.export" | "performance.manage" | "performance.finalize";
type Filter = { month: string; department: string; employee: string; query: string; arrivalStatus: string; page: number; arrivalPage: number; punctualityPage: number };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function requirePerformance(actor: Actor, action: Privilege = "performance.read") {
  if (!performanceEnabled()) return fail(404, "Performance reports are not enabled.");
  requireStaff(actor);
  if (!hasAction(actor, action)) return fail(403, "Your reporting permissions do not allow this action.");
}

function organizationAllowed(actor: Actor, action: Privilege) {
  if (canSuper(actor)) return true;
  const permissions = (actor.permissions ?? []).filter(rule => rule.action === action);
  return permissions.some(rule => rule.scope_type === "organization" && rule.effect === "allow")
    && !permissions.some(rule => rule.effect === "deny");
}

function monthValue(value: unknown) {
  const month = str(value, "month", 7);
  if (!/^(19[0-9]{2}|20[0-9]{2})-(0[1-9]|1[0-2])$/.test(month)) return fail(400, "Choose a valid year and month.");
  return month;
}

function filters(actor: Actor, params: URLSearchParams): Filter {
  const month = monthValue(params.get("month") ?? localDate(now(), actor.time_zone).slice(0, 7));
  const arrivalStatus = params.get("arrivalStatus") ? pick(params.get("arrivalStatus"), arrivalStatuses, "arrival status") : "";
  return {
    month, arrivalStatus, department: str(params.get("department"), "department", 80, false),
    employee: str(params.get("employee"), "employee", 80, false), query: str(params.get("q"), "search", 120, false).toLowerCase(),
    page: integer(params.get("page") ?? 1, "employee page", 1, 10_000),
    arrivalPage: integer(params.get("arrivalPage") ?? 1, "arrival page", 1, 10_000),
    punctualityPage: integer(params.get("punctualityPage") ?? 1, "punctuality page", 1, 10_000),
  };
}

async function peopleWithin(db: Db, actor: Actor, access: Privilege[], employee?: string) {
  const rules = access.map(action => actionScope(actor, action, "e"));
  return all<ReportEmployee>(db, `SELECT e.id,e.org_id,e.name,e.title AS designation,e.department_id,d.name AS department,
    e.hire_date,e.employment_end,e.created_at,e.jurisdiction,e.time_zone,
    EXISTS (SELECT 1 FROM staff_avatars photo WHERE photo.employee_id=e.id) AS has_photo
    FROM employees e LEFT JOIN units d ON d.id=e.department_id AND d.org_id=e.org_id
    WHERE e.org_id=? AND e.role<>'guest' AND (${rules.map(rule => `(${rule.sql})`).join(" AND ")})
      AND (?='' OR e.id=?)
    ORDER BY e.name,e.id LIMIT 5001`, actor.org_id, ...rules.flatMap(rule => rule.args), employee ?? "", employee ?? "");
}

async function modelVersions(db: Db, actor: Actor, through: string) {
  return all<Model>(db, `SELECT DISTINCT ON (effective_month) id,effective_month,weights
    FROM staff_performance_weights WHERE org_id=? AND release_stage=? AND effective_month<=?
    ORDER BY effective_month DESC,revision DESC`, actor.org_id, workDataset(), through);
}

function effectiveModel(versions: Model[], month: string): PerformanceModel {
  const version = versions.find(item => item.effective_month <= month);
  return version ? { version: version.id, effectiveMonth: version.effective_month, weights: version.weights }
    : { version: "baseline-1", effectiveMonth: null, weights: baseline };
}

async function savedReports(db: Db, actor: Actor, from: string, to: string) {
  const reports = await all<Saved>(db, `SELECT month,snapshot,snapshot_hash,finalized_at FROM staff_performance_reports
    WHERE org_id=? AND release_stage=? AND month BETWEEN ? AND ?`, actor.org_id, workDataset(), from, to);
  return new Map(reports.map(report => {
    const snapshot = JSON.parse(report.snapshot) as ReportSnapshot;
    if (hash(report.snapshot) !== report.snapshot_hash || snapshot.month !== report.month || snapshot.version !== 1) {
      return fail(409, "The saved report failed verification. Contact a Super Admin.");
    }
    return [report.month, { snapshot, finalizedAt: report.finalized_at }];
  }));
}

function periodsEnding(month: string): Period[] {
  return Array.from({ length: 6 }, (_, index) => periodOf(new Date(Date.UTC(
    Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 6 + index, 1,
  )).toISOString().slice(0, 7)));
}

function ranking(rows: (PerformanceEmployee & PerformancePerson)[], getValue: (row: PerformanceEmployee) => number | null) {
  const eligible = rows.flatMap(row => {
    const score = getValue(row);
    return score === null ? [] : [{ row, score }];
  }).sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name) || a.row.id.localeCompare(b.row.id));
  let place = 0, prior: number | null = null;
  return new Map(eligible.map(({ row, score }, index) => {
    if (score !== prior) place = index + 1;
    prior = score;
    return [row.id, place];
  }));
}

function applyScope(snapshot: ReportSnapshot, directory: Map<string, PerformancePerson>, filter: Filter) {
  const employees = snapshot.employees.flatMap(row => {
    const person = directory.get(row.id);
    if (!person || (filter.employee && row.id !== filter.employee) ||
      (filter.department && (row.departmentId ?? "unassigned") !== filter.department)) return [];
    if (filter.query && ![person.name, row.department, row.designation].some(value => value.toLowerCase().includes(filter.query))) return [];
    return [{ ...person, ...row }];
  });
  const byId = new Map(employees.map(employee => [employee.id, employee]));
  const arrivals = snapshot.arrivals.flatMap(row => {
    const employee = byId.get(row.employeeId);
    return employee ? [{ ...row, name: employee.name }] : [];
  });
  return { employees, arrivals };
}

function aggregate(rows: PerformanceEmployee[]) {
  const attendance = summarizeAttendance(rows.reduce((acc, { attendance }) => {
    for (const key of Object.keys(acc) as (keyof typeof acc)[]) acc[key] += attendance[key];
    return acc;
  }, { onTime: 0, early: 0, late: 0, absent: 0, missing: 0, pending: 0, upcoming: 0, excluded: 0 }));
  const work = (key: "tasks" | "projects" | "milestones"): CompletionMetrics => {
    const stats = rows.reduce((sum, item) => ({
      due: sum.due + item[key].due,
      completed: sum.completed + item[key].completed,
      completedThisMonth: sum.completedThisMonth + item[key].completedThisMonth,
    }), { due: 0, completed: 0, completedThisMonth: 0 });
    return { ...stats, percent: stats.due ? Math.round(stats.completed / stats.due * 1000) / 10 : null };
  };
  const scores = rows.flatMap(row => row.score === null ? [] : [row.score]);
  return { employees: rows.length, ranked: scores.length,
    score: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10 : null,
    attendance, tasks: work("tasks"), projects: work("projects"), milestones: work("milestones") };
}

async function assessments(db: Db, actor: Actor, employees: readonly string[], month: string) {
  if (!employees.length || (!hasAction(actor, "performance.manage") && !hasAction(actor, "performance.finalize"))) return [];
  const manage = actionScope(actor, "performance.manage", "e"), review = actionScope(actor, "performance.finalize", "e");
  const rows = await all<PerformanceAssessment & { created_by: string; is_self: boolean; can_review: boolean }>(db, `
    SELECT a.id,a.employee_id,a.review_score,a.quality_score,a.evidence,a.created_at,a.created_by,d.decision,
      e.id=? AS is_self,(${review.sql}) AS can_review
    FROM staff_performance_assessments a JOIN employees e ON e.id=a.employee_id AND e.org_id=a.org_id
    LEFT JOIN staff_performance_assessment_decisions d ON d.assessment_id=a.id AND d.org_id=a.org_id AND d.release_stage=a.release_stage
    WHERE a.org_id=? AND a.release_stage=? AND a.month=? AND a.employee_id=ANY(?::text[]) AND ((${manage.sql}) OR (${review.sql}))
    ORDER BY a.created_at DESC,a.id LIMIT 200`, actor.id, ...review.args, actor.org_id, workDataset(), month, employees, ...manage.args, ...review.args);
  return rows.map(({ created_by, is_self, can_review, ...row }) => ({ ...row, canDecide: can_review && !is_self && !row.decision && created_by !== actor.id }));
}

export async function buildPerformanceReport(db: Db, actor: Actor, params: URLSearchParams, exporting = false) {
  requirePerformance(actor, "performance.read");
  if (exporting) requirePerformance(actor, "performance.export");
  const at = now(), filter = filters(actor, params), period = periodOf(filter.month);
  const periods = exporting ? [period] : periodsEnding(filter.month);
  const first = periods[0];
  const [people, saved, versions] = await Promise.all([
    peopleWithin(db, actor, exporting ? ["performance.read", "performance.export"] : ["performance.read"], exporting ? filter.employee : undefined),
    savedReports(db, actor, first.month, filter.month),
    modelVersions(db, actor, filter.month),
  ]);
  if (people.length > 5000) return fail(413, "Choose a smaller authorized employee scope.");
  if (filter.employee && !people.some(employee => employee.id === filter.employee)) return fail(403, "That employee is outside your report scope.");
  const directory = new Map(people.map(employee => [employee.id, reportPerson(employee)]));
  const livePeriods = periods.filter(item => !saved.has(item.month));
  const relevant = people.filter(employee => {
    const hired = employee.hire_date || employee.created_at.slice(0, 10);
    const departmentMatches = !filter.department || (employee.department_id ?? "unassigned") === filter.department;
    return (!filter.employee || employee.id === filter.employee) && departmentMatches && hired <= period.end && (!employee.employment_end || employee.employment_end >= first.start);
  });
  const evidence = livePeriods.length ? await performanceEvidence(db, actor, relevant, livePeriods[0].start, livePeriods.at(-1)!.end) : null;
  const snapshots = periods.map(item => {
    const retained = saved.get(item.month);
    return retained ?? { snapshot: calculatePerformance(evidence!, item, effectiveModel(versions, item.month), at), finalizedAt: null };
  });
  const current = snapshots.at(-1)!;
  const { employees, arrivals } = applyScope(current.snapshot, directory, filter);
  const scoreRank = ranking(employees, row => row.score);
  const timeRank = ranking(employees, row => row.attendance.missing || row.attendance.pending ? null : row.attendance.punctualityPercent);
  const sorted: RankedEmployee[] = employees.map(row => ({
    ...row, rank: scoreRank.get(row.id) ?? null, punctualityRank: timeRank.get(row.id) ?? null,
  })).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const arrival = arrivals.filter(row => !filter.arrivalStatus || row.status === filter.arrivalStatus)
    .sort((a, b) => a.scheduled.localeCompare(b.scheduled) || a.id.localeCompare(b.id));
  if (exporting) return { exporting: true as const, month: filter.month, finalizedAt: current.finalizedAt, model: current.snapshot.model, employees: sorted, arrival };
  const timeLeaders = sorted.filter(row => row.punctualityRank !== null).sort((a, b) => a.punctualityRank! - b.punctualityRank! || a.name.localeCompare(b.name));
  const groups = new Map<string | null, PerformanceEmployee[]>();
  for (const row of employees) {
    const group = groups.get(row.departmentId) ?? [];
    group.push(row);
    groups.set(row.departmentId, group);
  }
  const departmentSummary = [...groups].map(([id, rows]) => ({ id, department: rows[0].department, ...aggregate(rows) }))
    .sort((a, b) => a.department.localeCompare(b.department));
  const departments = new Map<string, string>();
  for (const row of directory.values()) departments.set(row.departmentId ?? "unassigned", row.department);
  for (const {snapshot} of snapshots) for (const row of snapshot.employees) {
    if (directory.has(row.id) && !departments.has(row.departmentId ?? "unassigned")) departments.set(row.departmentId ?? "unassigned", row.department);
  }
  const trends = snapshots.map(entry => ({
    month: entry.snapshot.month, finalized: !!entry.finalizedAt,
    ...aggregate(applyScope(entry.snapshot, directory, filter).employees),
  }));
  const manageable = hasAction(actor, "performance.manage");
  const [reviews, reviewPeople] = await Promise.all([
    assessments(db, actor, employees.map(row => row.id), filter.month),
    manageable && !current.finalizedAt ? peopleWithin(db, actor, ["performance.read", "performance.manage"]) : [],
  ]);
  const page = (requested: number, total: number) => Math.min(requested, Math.max(1, Math.ceil(total / pageSize)));
  const slice = <T>(rows: T[], number: number) => rows.slice((number - 1) * pageSize, number * pageSize);
  const pages = { employees: page(filter.page, sorted.length), arrival: page(filter.arrivalPage, arrival.length), punctuality: page(filter.punctualityPage,timeLeaders.length) };
  const report: PerformancePage & { exporting: false } = {
    exporting: false, month: filter.month, finalizedAt: current.finalizedAt, model: current.snapshot.model,
    departments: [...departments].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    people: [...directory.values()], leaders: sorted.filter(row => row.rank !== null).slice(0,3),
    employees: slice(sorted, pages.employees), punctuality: slice(timeLeaders, pages.punctuality),
    arrival: slice(arrival, pages.arrival), departmentSummary, trends, assessments: reviews,
    reviewPeople: reviewPeople.filter(row => row.id !== actor.id && (row.hire_date || row.created_at.slice(0, 10)) <= period.end
      && (!row.employment_end || row.employment_end >= period.start)).map(reportPerson),
    canConfigure: organizationAllowed(actor, "performance.manage"),
    canFinalize: !current.finalizedAt && performanceClosed(period, at) && organizationAllowed(actor, "performance.finalize") && organizationAllowed(actor, "performance.read"),
    canExport: hasAction(actor, "performance.export"),
    canSubmitAssessment: manageable && !current.finalizedAt,
    totals: { employees: sorted.length, arrival: arrival.length, punctuality: timeLeaders.length }, pages, pageSize,
  };
  return report;
}

function parseWeights(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(400, "Enter the scoring weights.");
  const settings = value as Record<string, unknown>;
  const weights = {} as PerformanceWeights;
  for (const factor of Object.keys(performanceFactors) as PerformanceFactor[]) {
    weights[factor] = integer(settings[factor], performanceFactors[factor] + " weight", 0, 100);
  }
  if (Object.values(weights).reduce((sum, weight) => sum + weight, 0) !== 100) return fail(400, "Scoring weights must add up to 100.");
  return weights;
}

export async function performanceAction(db: Db, actor: Actor, data: Record<string, unknown>) {
  requirePerformance(actor);
  const action = pick(data.action, ["model-save", "assessment-submit", "assessment-decide", "finalize"], "performance action");
  const capability = action === "finalize" || action === "assessment-decide" ? "performance.finalize" : "performance.manage";
  requirePerformance(actor, capability);
  const month = monthValue(data.month);
  const period = periodOf(month);
  return db.transaction(async tx => {
    await run(tx, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await one(tx, "SELECT id FROM organizations WHERE id=? FOR UPDATE", actor.org_id);
    const stage = workDataset(), at = now();
    if (await one(tx, "SELECT id FROM staff_performance_reports WHERE org_id=? AND release_stage=? AND month=?", actor.org_id, stage, month)) {
      return fail(409, "This monthly report is finalized.");
    }
    if (action === "model-save") {
      if (!organizationAllowed(actor, capability)) return fail(403, "Organization-wide scoring authority is required.");
      const weights = parseWeights(data.weights);
      const reason = str(data.reason, "change reason", 1000);
      const rev = await one<{ revision: number }>(tx, `SELECT COALESCE(MAX(revision),0)::int AS revision FROM staff_performance_weights
        WHERE org_id=? AND release_stage=? AND effective_month=?`, actor.org_id, stage, month);
      await run(tx, `INSERT INTO staff_performance_weights (id,org_id,release_stage,effective_month,revision,weights,reason,created_by,created_at)
        VALUES (?,?,?,?,?,?::jsonb,?,?,?)`, id(), actor.org_id, stage, month, (rev?.revision ?? 0)+1, JSON.stringify(weights), reason, actor.id, at);
      await audit(tx, actor, "Performance scoring weights configured", "performance report", month).run();
      return { message: "A new scoring configuration was saved." };
    }
    if (action === "assessment-submit") {
      const employee = str(data.employee, "employee", 80);
      if (employee === actor.id) return fail(403, "Employees cannot submit their own performance assessment.");
      await requireEmployeeAction(tx, actor, "performance.read", employee);
      await requireEmployeeAction(tx, actor, capability, employee);
      const person = (await peopleWithin(tx, actor, ["performance.read", "performance.manage"], employee))[0];
      if (!person || (person.hire_date || person.created_at.slice(0, 10)) > period.end ||
        (person.employment_end && person.employment_end < period.start)) return fail(400, "Choose an employee who worked during this month.");
      if (month > localDate(at, actor.time_zone).slice(0, 7)) return fail(400, "Assess a current or past month.");
      const score = integer(data.reviewScore, "review score", 0, 100);
      const quality = data.qualityScore === "" || data.qualityScore == null ? null : integer(data.qualityScore, "quality score", 0, 100);
      const evidence = str(data.evidence, "assessment evidence", 1500);
      const assessment = id();
      await run(tx, `INSERT INTO staff_performance_assessments
        (id,org_id,release_stage,employee_id,month,review_score,quality_score,evidence,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, assessment, actor.org_id, stage, employee, month, score, quality, evidence, actor.id, at);
      await audit(tx, actor, "Performance assessment submitted", "employee", employee).run();
      return { message: "The assessment was sent for independent review." };
    }
    if (action === "assessment-decide") {
      const target = str(data.id, "assessment", 80);
      const assessment = await one<{ employee_id: string; created_by: string }>(tx, `SELECT employee_id,created_by
        FROM staff_performance_assessments WHERE id=? AND org_id=? AND release_stage=? AND month=?`, target, actor.org_id, stage, month);
      if (!assessment) return fail(404, "Assessment unavailable.");
      if ([assessment.created_by, assessment.employee_id].includes(actor.id)) return fail(403, "A different authorized administrator must decide.");
      await requireEmployeeAction(tx, actor, "performance.read", assessment.employee_id);
      await requireEmployeeAction(tx, actor, capability, assessment.employee_id);
      const decision = pick(data.decision, ["Approved", "Rejected"], "assessment decision");
      const reason = str(data.reason, "decision reason", 1000);
      if (await one(tx, "SELECT assessment_id FROM staff_performance_assessment_decisions WHERE assessment_id=?", target)) return fail(409, "The assessment has already been reviewed.");
      await run(tx, `INSERT INTO staff_performance_assessment_decisions
        (assessment_id,org_id,release_stage,decision,reason,decided_by,decided_at) VALUES (?,?,?,?,?,?,?)`,
        target, actor.org_id, stage, decision, reason, actor.id, at);
      await audit(tx, actor, `Performance assessment ${decision.toLowerCase()}`, "employee", assessment.employee_id).run();
      return { message: "The assessment decision was recorded." };
    }
    if (!organizationAllowed(actor, capability) || !organizationAllowed(actor, "performance.read")) return fail(403, "Organization-wide finalization and read authority are required.");
    if (!performanceClosed(period, at)) return fail(409, "Finalize after the selected month closes in all worksite time zones.");
    if (data.confirm !== true) return fail(400, "Confirm that the report is ready to freeze.");
    const people = await peopleWithin(tx, actor, ["performance.read"]);
    if (people.length > 5000) return fail(413, "The organization exceeds the current report finalization limit.");
    const evidence = await performanceEvidence(tx, actor, people, period.start, period.end);
    const version = effectiveModel(await modelVersions(tx, actor, month), month);
    const snapshot = JSON.stringify(calculatePerformance(evidence, period, version, at));
    await run(tx, `INSERT INTO staff_performance_reports
      (id,org_id,release_stage,month,snapshot,snapshot_hash,finalized_by,finalized_at) VALUES (?,?,?,?,?,?,?,?)`,
      id(),actor.org_id,stage,month,snapshot,hash(snapshot),actor.id,at);
    await audit(tx, actor, "Monthly employee performance finalized", "performance report", month).run();
    return { message: "The monthly report was finalized. Its scores and evidence are now frozen." };
  });
}

export async function performancePhoto(db: Db, actor: Actor, target: string) {
  requirePerformance(actor);
  await requireEmployeeAction(db, actor, "performance.read", str(target, "employee", 80));
  const photo = await one<{ content: Uint8Array; mime: string }>(db, "SELECT content,mime FROM staff_avatars WHERE employee_id=?", target);
  if (!photo) return fail(404, "No profile photo has been uploaded.");
  return new Response(Uint8Array.from(photo.content), { headers: {
    "Content-Type": photo.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'", "Cross-Origin-Resource-Policy": "same-origin",
  } });
}
