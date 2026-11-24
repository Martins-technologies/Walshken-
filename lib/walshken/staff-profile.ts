import {scanStaffUpload} from "./staff-delivery";
import { audit, cookieValue, digest, fail, json, now, one, run, sessionCookie, stmt, str, throttle, type Actor, type Db } from "./server";

export async function updateContactNumber(db: Db, actor: Actor, data: Record<string, unknown>) {
  if (typeof data.phone !== "string") return fail(400, "Enter a phone number or leave the field empty.");
  const phone = str(data.phone, "phone number", 40, false);
  if (phone && (!/^[+0-9().\s-]+(?:\s*(?:ext\.?|x)\s*\d+)?$/i.test(phone) || phone.replace(/\D/g, "").length < 5)) {
    return fail(400, "Enter a valid phone number.");
  }
  await throttle(db, `profile-contact:${actor.id}`, 10, 60_000);
  await db.transaction(async (tx) => {
    const changed = await run(tx, `UPDATE employees SET phone=? WHERE id=? AND org_id=?
      AND status='Active' AND employment_status<>'Ended' AND phone IS DISTINCT FROM ?`, phone || null, actor.id, actor.org_id, phone || null);
    if (changed.count) await audit(tx, actor, "Profile contact number updated", "employee", actor.id).run();
  });
  return json({ ok: true, message: "Contact number saved." });
}

export async function updateAvatar(db: Db, actor: Actor, request: Request) {
  await throttle(db, `profile-photo:${actor.id}`, 10, 60_000);
  const max = 1024 * 1024;
  if (Number(request.headers.get("content-length") || 0) > max + 10_000) fail(413, "Choose an image under 1 MB.");
  const file = (await request.formData()).get("photo");
  if (!(file instanceof File) || file.size < 12 || file.size > max) return fail(400, "Choose a PNG, JPEG, or WebP under 1 MB.");
  const content = Buffer.from(await file.arrayBuffer());
  const png = content.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  const jpeg = content.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
  const webp = content.subarray(0, 4).toString() === "RIFF" && content.subarray(8, 12).toString() === "WEBP";
  if (!png && !jpeg && !webp) fail(400, "Choose a valid PNG, JPEG, or WebP.");
  await scanStaffUpload(db,content,actor,file.name);
  await db.batch([
    stmt(db, `INSERT INTO staff_avatars (employee_id,mime,content,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(employee_id) DO UPDATE SET mime=excluded.mime,content=excluded.content,updated_at=excluded.updated_at`,
    actor.id, png ? "image/png" : jpeg ? "image/jpeg" : "image/webp", content, now()),
    audit(db, actor, "Profile photo updated", "employee", actor.id),
  ]);
  return json({ ok: true, message: "Profile photo updated." });
}

export async function staffAvatar(db: Db, actor: Actor) {
  const photo = await one<{ content: Uint8Array; mime: string }>(db, "SELECT content,mime FROM staff_avatars WHERE employee_id=?", actor.id);
  if (!photo) return fail(404, "No profile photo has been uploaded.");
  return new Response(Uint8Array.from(photo.content), { headers: {
    "Content-Type": photo.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'", "Cross-Origin-Resource-Policy": "same-origin",
  } });
}

export async function removeAvatar(db: Db, actor: Actor) {
  await db.transaction(async (tx) => {
    const result = await run(tx, "DELETE FROM staff_avatars WHERE employee_id=?", actor.id);
    if (result.count) await audit(tx, actor, "Profile photo removed", "employee", actor.id).run();
  });
  return json({ ok: true, message: "Profile photo removed." });
}

export async function closeOtherSessions(db: Db, actor: Actor, request: Request) {
  const current = await digest(cookieValue(request.headers.get("cookie"), sessionCookie));
  await db.batch([
    stmt(db, "UPDATE sessions SET ended_at=? WHERE employee_id=? AND id<>? AND ended_at IS NULL", now(), actor.id, current),
    audit(db, actor, "Other sessions ended", "session"),
  ]);
  return json({ ok: true, message: "Other sessions ended." });
}
