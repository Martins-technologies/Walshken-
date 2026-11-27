import { clientPortalEnabled } from "./client-feature";
import { all, fail, one, type Db } from "./server";

/** Staff meetings and client bookings serialize on the same employee row locks. */
export async function guardClientAppointmentsForStaff(
  db:Db, org:string, participants:readonly string[], starts:string, ends:string,
) {
  if (!clientPortalEnabled() || !participants.length) return;
  await all(db,"SELECT id FROM employees WHERE org_id=? AND id=ANY(?::text[]) ORDER BY id FOR UPDATE",org,participants);
  const conflict=await one(db,`SELECT id FROM client_appointments WHERE org_id=? AND employee_id=ANY(?::text[])
    AND status='Booked' AND starts_at<? AND ends_at>? LIMIT 1`,org,participants,ends,starts);
  if (conflict) return fail(409,"A meeting participant already has a client appointment at that time.");
}
