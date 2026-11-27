import { actionScope } from "./staff-authority";
import { all, now, type Actor, type Db } from "./server";
import { workDataset } from "./workforce";

export const expectedTimesheetsEnabled = () => process.env.WALSHKEN_PROJECT_LIFECYCLE_ENABLED === "1";

// Use the timezone kept on the scheduled shift/attendance record. A shift can
// predict a follow-up but never produces payable time without attendance.
const localDay = (column: string, alias: string) => `to_char(${column}::timestamptz AT TIME ZONE
  (CASE WHEN ${alias}.time_zone IN ('America/Edmonton','Canada/Mountain') AND ${column}>='2026-11-01T00:00:00Z'
    THEN 'Etc/GMT+6' ELSE ${alias}.time_zone END),'YYYY-MM-DD')`;

export async function expectedTimesheets(db: Db, actor: Actor, from: string, through: string, ownOnly = false) {
  const scope = ownOnly ? {sql:"e.id=?",args:[actor.id]} : actionScope(actor,"timesheets.read","e",true);
  const stage = workDataset();
  const first = new Date(Date.parse(from+"T00:00:00Z")-86_400_000).toISOString();
  const last = new Date(Date.parse(through+"T00:00:00Z")+172_800_000).toISOString();
  const rows = await all(db, `
    WITH completed AS (
      SELECT a.id,a.employee_id,e.name,a.shift_id,a.starts_at,a.ends_at,a.time_zone,
        ${localDay("a.starts_at","a")} AS work_date, 'Missing timesheet'::text AS issue
      FROM attendance a JOIN employees e ON e.id=a.employee_id AND e.org_id=a.org_id
      WHERE a.org_id=? AND a.release_stage=? AND a.workflow_version=1 AND a.ends_at<=?
        AND a.starts_at>=? AND a.starts_at<? AND (${scope.sql})
        AND NOT EXISTS(SELECT 1 FROM timesheets t WHERE t.attendance_id=a.id AND t.release_stage=a.release_stage)
    ), scheduled AS (
      SELECT s.id,s.employee_id,e.name,s.id AS shift_id,s.starts_at,s.ends_at,s.time_zone,
        ${localDay("s.starts_at","s")} AS work_date,'Attendance follow-up'::text AS issue
      FROM shifts s JOIN employees e ON e.id=s.employee_id AND e.org_id=s.org_id
      WHERE s.org_id=? AND s.release_stage=? AND s.workflow_version=1 AND s.state='Published'
        AND s.starts_at>=? AND s.starts_at<? AND s.ends_at<? AND (${scope.sql})
        AND NOT EXISTS(SELECT 1 FROM attendance a WHERE a.employee_id=s.employee_id
          AND a.org_id=s.org_id AND a.release_stage=s.release_stage AND a.workflow_version=1
          AND (a.shift_id=s.id OR (a.shift_id IS NULL AND a.starts_at<s.ends_at AND (a.ends_at IS NULL OR a.ends_at>s.starts_at))))
        AND NOT EXISTS(SELECT 1 FROM leave_requests l WHERE l.org_id=s.org_id AND l.release_stage=s.release_stage
          AND l.employee_id=s.employee_id AND l.status='Approved' AND l.starts_on<=${localDay("s.starts_at","s")} AND l.ends_on>=${localDay("s.ends_at","s")})
        AND NOT EXISTS(SELECT 1 FROM attendance_absences x WHERE x.shift_id=s.id AND x.release_stage=s.release_stage AND x.manual_excuse=1)
    ), issues AS (
      SELECT * FROM completed WHERE work_date BETWEEN ? AND ?
      UNION ALL SELECT * FROM scheduled WHERE work_date BETWEEN ? AND ?
    )
    SELECT * FROM (SELECT issues.*,count(*) OVER(PARTITION BY issue)::int AS issue_count,
      row_number() OVER(PARTITION BY issue ORDER BY work_date DESC,starts_at DESC,id) AS issue_rank FROM issues) ranked
    WHERE issue_rank<=75 ORDER BY issue DESC,work_date DESC,starts_at DESC,id`,
    actor.org_id,stage,now(),first,last,...scope.args,actor.org_id,stage,first,last,now(),...scope.args,from,through,from,through);
  // The admin dashboard needs exact totals even when the bounded list is full.
  // Keep at least one representative from each issue bucket in the result.
  return rows;
}
