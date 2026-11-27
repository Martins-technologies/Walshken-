import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { audit, fail, pick, throttle, type Actor, type Db } from "./server";
import { buildPerformanceReport, requirePerformance } from "./staff-performance";
import { performanceFactors, type PerformanceFactor } from "./staff-performance-types";

const asPercent = (n: number | null) => n === null ? "" : n + "%";
function quote(value: string | number | null) {
  const cell = typeof value === "string" ? value.replace(/^\s*[=+@-]|^[\t\r\n]/, "'$&") : String(value ?? "");
  return '"' + cell.replaceAll('"', '""') + '"';
}

export async function downloadPerformanceReport(db: Db, actor: Actor, params: URLSearchParams) {
  requirePerformance(actor, "performance.export");
  const format = pick(params.get("format"), ["csv","pdf"], "export format");
  const type = pick(params.get("report") ?? "performance", ["performance","arrival"], "export report");
  await throttle(db, `performance-export:${actor.id}`, 20, 60_000);
  const data = await buildPerformanceReport(db, actor, params, true);
  if (!data.exporting) return fail(500, "The report could not be exported.");
  const { month, finalizedAt, model, employees, arrival } = data;
  const status = finalizedAt ? "Finalized" : "Provisional";
  const length = type === "arrival" ? arrival.length : employees.length;
  if (length > (format === "pdf" ? 500 : 10_000)) return fail(413, "Filter by employee or department to export a report this size.");

  const headings = type === "arrival"
    ? ["Month","Report status","Employee","Shift date","Scheduled start UTC","Actual check-in UTC","Worksite time zone","Difference minutes","Grace minutes","Status","Explanation"]
    : ["Month","Report status","Rank","Employee","Department","Job designation","Score","Measured weight",
      "Scheduled shifts measured","Attended","Attendance %","Punctuality %","On time","Early","Late","Confirmed absences",
      "Missing check-ins","Pending","Excluded","Tasks due","Tasks complete","Projects due","Projects complete","Milestones due",
      "Milestones complete","Approved manager assessment","Approved work quality","Unranked reason"];
  const csvRows = type === "arrival"
    ? arrival.map(row => [month,status,row.name,row.day,row.scheduled,row.checkedIn,row.timeZone,row.differenceMinutes,row.graceMinutes,row.status,row.reason])
    : employees.map(row => [
      month,status,row.rank,row.name,row.department,row.designation,row.score,row.measuredWeight,row.attendance.expected,
      row.attendance.attended,asPercent(row.attendance.attendancePercent),asPercent(row.attendance.punctualityPercent),
      row.attendance.onTime,row.attendance.early,row.attendance.late,row.attendance.absent,row.attendance.missing,row.attendance.pending,
      row.attendance.excluded,row.tasks.due,row.tasks.completed,row.projects.due,row.projects.completed,row.milestones.due,row.milestones.completed,
      row.review,row.quality,row.reason,
    ]);
  const headers = {
    "Content-Disposition": `attachment; filename="walshken-${type}-${month}.${format}"`,
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  };
  if (format === "csv") {
    await audit(db, actor, "Employee performance CSV downloaded", "performance report", month).run();
    return new Response("\uFEFF" + [headings, ...csvRows].map(row => row.map(quote).join(",")).join("\r\n"), {
      headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" },
    });
  }

  const pdf = await PDFDocument.create();
  pdf.setTitle(`Walshken ${type === "arrival" ? "attendance and arrivals" : "monthly employee performance"} · ${month}`);
  pdf.setAuthor("Walshken");
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await readFile(join(process.cwd(), "public/payroll-font.ttf")), { subset: true });
  const color = rgb(.06,.12,.24), muted = rgb(.31,.39,.53);
  let page = pdf.addPage([595,842]), y = 795;
  function line(input: string, size = 10, secondary = false) {
    const words = input.replace(/[\x00-\x1f\x7f]/g, " ").split(/\s+/).filter(Boolean);
    let segment = "";
    const draw = (value: string) => {
      if (!value) return;
      if (y < 52) {
        page = pdf.addPage([595,842]);
        y = 795;
      }
      page.drawText(value, { x: 46, y, size, font, color: secondary ? muted : color, maxWidth: 500 });
      y -= size + 6;
    };
    for (const word of words) {
      const candidate = segment ? segment + " " + word : word;
      if (font.widthOfTextAtSize(candidate,size) > 498 && segment) {
        draw(segment);
        segment = word;
      } else segment = candidate;
    }
    draw(segment);
  }

  line(type === "arrival" ? "Attendance and arrival report" : "Monthly employee performance", 18);
  line(`${month} · ${status} · ${length} records in the authorized scope`, 10, true);
  if (type === "performance") {
    const weights = Object.keys(model.weights) as PerformanceFactor[];
    line(weights.map(key => `${performanceFactors[key]} ${model.weights[key]}%`).join(" · "), 9, true);
  }
  y -= 10;
  if (type === "arrival") {
    for (const row of arrival) {
      line(`${row.name} · ${row.day} · ${row.status}`, 12);
      line(`Scheduled ${row.scheduled} · Check-in ${row.checkedIn ?? "Unavailable"} · ${row.timeZone}`);
      line(`Difference ${row.differenceMinutes === null ? "unavailable" : row.differenceMinutes + " min"} · ${row.reason}`, 9, true);
      y -= 8;
    }
  } else {
    for (const row of employees) {
      line(`${row.rank === null ? "Unranked" : "#" + row.rank} · ${row.name} · ${row.score === null ? "Score unavailable" : row.score.toFixed(1) + " / 100"}`, 12);
      line(`${row.department} · ${row.designation} · ${row.measuredWeight}% of configured weight measured`, 9, true);
      line(`Attendance ${asPercent(row.attendance.attendancePercent) || "unavailable"} · Punctuality ${asPercent(row.attendance.punctualityPercent) || "unavailable"}`);
      line(`On time ${row.attendance.onTime} · Early ${row.attendance.early} · Late ${row.attendance.late} · Absent ${row.attendance.absent} · Missing ${row.attendance.missing}`);
      line(`Tasks ${row.tasks.completed}/${row.tasks.due} · Projects ${row.projects.completed}/${row.projects.due} · Milestones ${row.milestones.completed}/${row.milestones.due}`);
      if (row.review !== null || row.quality !== null) line(`Approved manager assessment ${row.review ?? "not recorded"} · Work quality ${row.quality ?? "not recorded"}`);
      if (row.reason) line(row.reason, 9, true);
      y -= 8;
    }
  }
  if (!length) line("No qualifying records match the selected filters.");
  const body = new Uint8Array(await pdf.save());
  await audit(db, actor, "Employee performance PDF downloaded", "performance report", month).run();
  return new Response(body, { headers: { ...headers, "Content-Type": "application/pdf" } });
}
