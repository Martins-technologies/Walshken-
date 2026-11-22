import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { passwordMatches } from "./passwords";
import { audit, decryptSettings, digest, encryptSettings, expiredSession, fail, json, now, one, run, staffMfaRequired, throttle, type Actor, type Db } from "./server";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const stepSeconds = 30;

function base32(bytes: Buffer): string {
  let bits = 0;
  let remaining = 0;
  let output = "";
  for (const byte of bytes) {
    remaining = (remaining << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(remaining >>> bits) & 31];
    }
  }
  return bits ? output + alphabet[(remaining << (5 - bits)) & 31] : output;
}

function matchingStep(secret: Buffer, code: string): number | undefined {
  if (!/^\d{6}$/.test(code)) return;
  const current = Math.floor(Date.now() / (stepSeconds * 1000));
  const submitted = Buffer.from(code);
  for (const step of [current, current - 1, current + 1]) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const hashed = createHmac("sha1", secret).update(counter).digest();
    const offset = hashed[hashed.length - 1] & 15;
    const expected = String((hashed.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
    if (timingSafeEqual(Buffer.from(expected), submitted)) return step;
  }
}

const keyLabel = (employee: string) => `staff-mfa:${employee}`;

export async function verifyStaffMfa(db: Db, employee: string, code: unknown, required = false) {
  const factor = await one<{ secret: string; last_step: number }>(db,
    "SELECT secret,last_step FROM staff_mfa WHERE employee_id=? AND confirmed_at IS NOT NULL FOR UPDATE", employee);
  if (!factor) {
    if (required) fail(409, "Your authenticator has not been set up.");
    return;
  }
  const input = typeof code === "string" ? code.trim() : "";
  if (!input) fail(401, "Enter your authenticator or recovery code.");
  if (/^[a-f0-9]{24}$/i.test(input)) {
    const result = await run(db, "DELETE FROM staff_recovery_codes WHERE employee_id=? AND code_hash=?", employee, await digest(input.toLowerCase()));
    if (result.count === 1) return;
  }
  const { secret } = await decryptSettings(keyLabel(employee), factor.secret);
  const step = matchingStep(Buffer.from(secret, "base64"), input);
  if (step === undefined || step <= factor.last_step) fail(401, "Use a fresh authenticator or recovery code.");
  await run(db, "UPDATE staff_mfa SET last_step=? WHERE employee_id=?", step, employee);
}

export async function staffMfaAction(request: Request, db: Db, actor: Actor, action: string, data: Record<string, unknown>) {
  await throttle(db, `staff-mfa:${actor.id}`, 8, 300_000);
  const password = typeof data.password === "string" ? data.password : "";
  if (!password || password.length > 160) fail(400, "Enter your current password.");
  return db.transaction(async (tx) => {
    const credential = await one<{ password_hash: string }>(tx, "SELECT password_hash FROM credentials WHERE employee_id=? FOR UPDATE", actor.id);
    if (!await passwordMatches(password, credential?.password_hash)) fail(401, "Current password is incorrect.");
    const factor = await one<{ pending_secret: string | null; confirmed_at: string | null; setup_expires_at: string }>(tx,
      "SELECT pending_secret,confirmed_at,setup_expires_at FROM staff_mfa WHERE employee_id=? FOR UPDATE", actor.id);

    if (action === "setup") {
      if (factor?.confirmed_at) await verifyStaffMfa(tx,actor.id,data.code,true);
      const raw = randomBytes(20);
      const secret = await encryptSettings(keyLabel(actor.id), { secret: raw.toString("base64") });
      const expires = new Date(Date.now() + 10 * 60_000).toISOString();
      await run(tx, `INSERT INTO staff_mfa (employee_id,secret,pending_secret,setup_expires_at) VALUES (?,?,?,?)
        ON CONFLICT(employee_id) DO UPDATE SET pending_secret=excluded.pending_secret,setup_expires_at=excluded.setup_expires_at`,
        actor.id,secret,secret,expires);
      return json({ setupKey: base32(raw), account: actor.email });
    }

    if (action === "confirm") {
      if (!factor?.pending_secret || factor.setup_expires_at <= now()) return fail(409, "Start a new authenticator setup.");
      const { secret } = await decryptSettings(keyLabel(actor.id), factor.pending_secret);
      const step = matchingStep(Buffer.from(secret, "base64"), typeof data.code === "string" ? data.code.trim() : "");
      if (step === undefined) fail(401, "The authenticator code is incorrect or expired.");
      const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(12).toString("hex"));
      await run(tx, "UPDATE staff_mfa SET secret=?,pending_secret=NULL,confirmed_at=?,last_step=? WHERE employee_id=?",
        factor.pending_secret,now(),step,actor.id);
      await run(tx,"DELETE FROM staff_recovery_codes WHERE employee_id=?",actor.id);
      for (const code of recoveryCodes) {
        await run(tx, "INSERT INTO staff_recovery_codes (employee_id,code_hash) VALUES (?,?)", actor.id, await digest(code));
      }
      await run(tx, "UPDATE sessions SET ended_at=? WHERE employee_id=? AND ended_at IS NULL", now(), actor.id);
      await audit(tx, actor, factor.confirmed_at?"Authenticator replaced":"Authenticator enabled", "identity", actor.id).run();
      const response = expiredSession(request);
      return json({ recoveryCodes }, 200, { "Set-Cookie": response.headers.get("set-cookie")! });
    }

    if (action === "disable") {
      if (staffMfaRequired()) return fail(409, "Your workspace requires an authenticator.");
      await verifyStaffMfa(tx, actor.id, data.code, true);
      await run(tx, "DELETE FROM staff_mfa WHERE employee_id=?", actor.id);
      await run(tx, "UPDATE sessions SET ended_at=? WHERE employee_id=? AND ended_at IS NULL", now(), actor.id);
      await audit(tx, actor, "Authenticator disabled", "identity", actor.id).run();
      return expiredSession(request);
    }
    return fail(404, "This authenticator action is unavailable.");
  });
}
