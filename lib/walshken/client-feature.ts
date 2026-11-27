import type { Db } from "./database";

export const clientPortalEnabled = () => process.env.WALSHKEN_CLIENT_PORTAL_ENABLED === "1";

export const clientNavigation = [
  ["overview", "Overview", "layout"], ["cases", "My cases", "project"], ["documents", "Documents", "file"],
  ["contact", "Messages & calls", "message"], ["payments", "Payments & invoices", "wallet"],
  ["agreements", "Agreements", "check"], ["notifications", "Notifications", "bell"],
  ["profile", "My profile", "user"], ["security", "Security & privacy", "shield"],
] as const;
export type ClientSection = (typeof clientNavigation)[number][0];

export async function withClientDb<T>(db: Db, customerId: string, work: (db: Db) => Promise<T>) {
  return db.transaction(async (transaction) => {
    await transaction.prepare("SELECT set_config('walshken.client_customer_id', ?, true)", [customerId]).run();
    return work(transaction);
  });
}
