import {createHmac, timingSafeEqual} from "node:crypto";

function equalSecret(supplied: string, expected: string) {
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function maintenanceAuthorized(authorization: string, secret: string, preview: boolean, epoch = Date.now()) {
  if (!secret || authorization.length > 512) return false;
  if (equalSecret(authorization, `Bearer ${secret}`)) return true;
  if (!preview) return false;
  const signed = /^WalshkenQACron (\d{10})\.([a-f0-9]{64})$/.exec(authorization);
  if (!signed || Math.abs(epoch / 1000 - Number(signed[1])) >= 90) return false;
  const signature = createHmac("sha256", secret).update(`walshken-management-maintenance:${signed[1]}`).digest("hex");
  return equalSecret(signed[2], signature);
}
