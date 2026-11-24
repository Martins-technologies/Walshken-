import { all, type Db } from "./server";
import { dailySegments, type WorkBreak } from "./attendance-rules";
import { payrollDataset, rateOn } from "./payroll-access";
import { wages, type DayWork } from "./payroll-work";
import { staffReadinessEnabled } from "./staff-permissions";
import type { PayPeriod, PayPolicy, PayRate } from "./payroll-types";

export type ReportingReview = {
  id: string;
  attendance_id: string;
  attendance_revision: number;
  classification: string;
  reason: string;
};

export async function reportingReviews(db: Db, org: string, employee: string, start: string, end: string) {
  if (!staffReadinessEnabled()) return [];
  return all<ReportingReview>(db,`SELECT DISTINCT ON (r.attendance_id) r.id,r.attendance_id,r.attendance_revision,r.classification,r.reason
    FROM staff_reporting_reviews r JOIN attendance a ON a.id=r.attendance_id AND a.revision=r.attendance_revision
    WHERE r.org_id=? AND r.release_stage=? AND a.employee_id=? AND a.ends_at>=? AND a.starts_at<?
    ORDER BY r.attendance_id,r.created_at DESC,r.id DESC`,org,payrollDataset(),employee,start,end);
}

// Alberta standard reporting periods are separated by unpaid gaps longer than one hour.
export function reportingSupplements(
  work: DayWork[], breaks: (WorkBreak & {attendance_id:string})[], reviews: ReportingReview[],
  period: PayPeriod, rates: PayRate[], policy: PayPolicy, minimumHourly: number, holidayMultiplier: string,
) {
  const sheets = new Map(work.filter(day=>day.sheet.status==="Approved" && day.day>=period.starts_on && day.day<=period.ends_on).map(day=>[day.sheet.id,day.sheet]));
  const added: {sheetId:string;day:string;amount:number;reviewId?:string;revision:number;minimum:number;actual:number;paidSeconds:number}[] = [];
  for (const sheet of sheets.values()) {
    const review = reviews.find(row=>row.attendance_id===sheet.attendance_id && row.attendance_revision===sheet.attendance_revision);
    if (review && review.classification!=="Required") continue;
    const intervals = breaks.filter(b=>b.attendance_id===sheet.attendance_id);
    const gaps = intervals.filter(b=>!b.paid && b.ends_at && Date.parse(b.ends_at)-Date.parse(b.starts_at)>3_600_000)
      .sort((a,b)=>a.starts_at.localeCompare(b.starts_at));
    const boundaries = [sheet.starts_at,...gaps.flatMap(gap=>[gap.starts_at,gap.ends_at!]),sheet.ends_at];
    const paidByDay = new Map<string,number>();
    for (let index=0; index<boundaries.length; index+=2) {
      const segments = dailySegments(boundaries[index],boundaries[index+1],intervals,sheet.time_zone);
      let actual = 0, paidSeconds = 0;
      for (const segment of segments) {
        const source = work.find(day=>day.sheet.id===sheet.id&&day.day===segment.day);
        if (!source) continue;
        const rate = rateOn(rates,segment.day);
        const previous = paidByDay.get(segment.day) ?? 0;
        const regular = Math.max(0,Math.min(segment.paid,source.regular-previous));
        paidByDay.set(segment.day,previous+segment.paid);
        paidSeconds += segment.paid;
        actual += source.holiday ? wages(rate,segment.paid,policy,holidayMultiplier)
          : wages(rate,regular,policy)+wages(rate,segment.paid-regular,policy,policy.overtimeMultiplier);
      }
      const day = segments.at(-1)?.day;
      const minimum = 3*minimumHourly;
      if (day && day>=period.starts_on && day<=period.ends_on && paidSeconds<3*3600 && actual<minimum) {
        added.push({sheetId:sheet.id,day,amount:minimum-actual,reviewId:review?.id,revision:sheet.revision,minimum,actual,paidSeconds});
      }
    }
  }
  return added;
}
