import {decryptSettings,fail,one,type Db} from "./server";
import {validateEmailSettings} from "./staff-delivery";

export type ClientEmailSender = {apiKey: string; from: string};

export async function clientEmailSender(db: Db) {
  const preview = process.env.VERCEL_ENV === "preview" || process.env.NODE_ENV === "test";
  const namedKey = preview ? process.env.WALSHKEN_CLIENT_RESEND_API_KEY : undefined;
  const namedFrom = preview ? process.env.WALSHKEN_CLIENT_RESEND_FROM : undefined;
  const integration = namedKey || namedFrom ? null
    : await one<{configuration: string}>(db, "SELECT configuration FROM integrations WHERE id='resend' AND enabled=1");
  const settings = namedKey || namedFrom ? {apiKey: namedKey ?? "", from: namedFrom ?? ""}
    : integration ? await decryptSettings("resend", integration.configuration) as ClientEmailSender : null;
  if (!settings) return null;
  validateEmailSettings(settings);
  return settings;
}

export function clientEmailOrigin() {
  const preview = process.env.VERCEL_ENV === "preview";
  const branch = process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL;
  const configured = preview ? branch && `https://${branch}` : process.env.WALSHKEN_CLIENT_EMAIL_ORIGIN || process.env.WALSHKEN_STAFF_EMAIL_ORIGIN;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol === "https:" && !url.username && !url.password && (!preview || url.hostname.endsWith(".vercel.app"))) return url.origin;
  } catch { /* Use the configured portal from the existing browser tab. */ }
  return null;
}

export async function requireClientEmailSender(db: Db) {
  const settings = await clientEmailSender(db).catch(() => null);
  if (!settings) return fail(503, "Email verification is unavailable because a verified sender is not connected. Contact Walshken support.");
  return settings;
}

export async function sendClientEmail(sender: ClientEmailSender, recipient: string, message: {subject: string; text: string}, key: string) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {Authorization: `Bearer ${sender.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": key},
    body: JSON.stringify({from: `Walshken <${sender.from}>`, to: [recipient], subject: message.subject, text: message.text}),
    redirect: "error",
    signal: AbortSignal.timeout(7_500),
    cache: "no-store",
  }).catch(() => null);
  const result = response?.ok ? await response.json().catch(() => null) : null;
  const receipt = typeof result?.id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(result.id) ? result.id as string : null;
  return {receipt, retryable: !response || response.ok || response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500};
}
