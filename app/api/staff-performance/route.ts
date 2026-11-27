import { audit, checkOrigin, currentActor, database, fail, handleError, json, needsStaffMfa, payload, throttle } from "@/lib/walshken/server";
import { buildPerformanceReport, performanceAction, performancePhoto, requirePerformance } from "@/lib/walshken/staff-performance";

export const runtime = "nodejs";
export const maxDuration = 120;

async function access(request: Request) {
  const db = database();
  const actor = await currentActor(db, request);
  if (!actor) return fail(401, "Sign in to your staff workspace.");
  if (needsStaffMfa(actor)) return fail(403, "Complete your authenticator setup first.");
  requirePerformance(actor);
  return { db, actor };
}

export async function GET(request: Request) {
  try {
    const { db, actor } = await access(request);
    const params = new URL(request.url).searchParams;
    if (params.has("photo")) return await performancePhoto(db, actor, params.get("photo") ?? "");
    if (params.has("format")) {
      const { downloadPerformanceReport } = await import("@/lib/walshken/staff-performance-export");
      return await downloadPerformanceReport(db, actor, params);
    }
    await throttle(db, `performance-view:${actor.id}`, 70, 60_000);
    const report = await buildPerformanceReport(db, actor, params);
    await audit(db, actor, "Employee performance report viewed", "performance report", report.month).run();
    return json(report);
  } catch (error) { return handleError(error); }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { db, actor } = await access(request);
    await throttle(db, `performance-change:${actor.id}`, 20, 60_000);
    return json(await performanceAction(db, actor, await payload(request)));
  } catch (error) { return handleError(error); }
}
