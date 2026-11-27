import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { workspaceDatabase } from "@/lib/walshken/database";
import { customerFor, customerToken } from "@/lib/walshken/customer";
import type { ClientSection } from "@/lib/walshken/client-feature";
import { ClientPortal } from "./client-portal";

export async function ClientPage({section, caseId}: {section:ClientSection; caseId?: string}) {
  const db = workspaceDatabase();
  const customer = db && await customerFor(db,customerToken((await headers()).get("cookie")));
  if (!customer) redirect("/customer/sign-in");
  return <ClientPortal section={section} person={{name:customer.name,email:customer.email}} initialCase={caseId}/>;
}
