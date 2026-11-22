import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SignIn } from "@/components/walshken/sign-in";
import { Workspace } from "@/components/walshken/workspace";
import { setupAllowed } from "@/lib/walshken/auth";
import { workspaceDatabase } from "@/lib/walshken/database";
import { actorFor, cookieValue, needsStaffMfa, one } from "@/lib/walshken/server";
import { adminNav, staffNav } from "@/lib/walshken/catalog";
import { canOpen } from "@/lib/walshken/views";

export const dynamic = "force-dynamic";
export const metadata = { title: "Staff workspace", robots: { index: false, follow: false } };

export default async function Staff({ params }: { params: Promise<{ section?: string[] }> }) {
  const {section:parts}=await params;
  if(parts&&parts.length>1) notFound();
  const section=parts?.[0]??"dashboard";
  const valid = [...staffNav.flatMap((group)=>group.items.map((item)=>item[0])),...adminNav.map((item)=>item[0])];
  if(!valid.includes(section as typeof valid[number])) notFound();
  const db=workspaceDatabase();
  if(!db) return <SignIn ready={false} initial={false}/>;
  let actor;
  let initial=false;
  try {
    actor=await actorFor(db,cookieValue((await headers()).get("cookie")));
    if(!actor) {
      const workspaceInitialized=await one(db,"SELECT id FROM employees LIMIT 1");
      initial=setupAllowed()&&!workspaceInitialized;
    }
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    const safeCode = code && /^[A-Z0-9_]{1,50}$/.test(code) ? code : "unknown";
    const errorType = !(error instanceof Error) ? "unknown" :
      /certificate|ssl|tls/i.test(error.message) ? "tls" :
      /tenant|user not found/i.test(error.message) ? "pooler identity" :
      /password|scram|authquery/i.test(error.message) ? "authentication" :
      /permission denied/i.test(error.message) ? "permissions" :
      /timeout|timed out/i.test(error.message) ? "timeout" : "unclassified";
    console.error("Walshken staff connection failed", safeCode, errorType);
    return <SignIn ready={false} initial={false}/>;
  }
  if(!actor) return <SignIn ready initial={initial}/>;
  const enrollmentRequired = needsStaffMfa(actor);
  if(enrollmentRequired && section!=="profile") redirect("/staff/profile");
  if(!canOpen(actor,section)) redirect("/staff");
  const allowed = enrollmentRequired ? ["profile"] : valid.filter((item)=>canOpen(actor,item));
  return <Workspace section={section} allowed={allowed} actor={{
    id:actor.id,name:actor.name,role:actor.role,timeZone:actor.time_zone,employeeNo:actor.employee_no,
  }}/>;
}
