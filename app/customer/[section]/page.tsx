import { notFound } from "next/navigation";
import { ClientPage } from "@/components/walshken/client-page";
import { clientNavigation, clientPortalEnabled } from "@/lib/walshken/client-feature";

export const metadata = {title:"Client Portal"};

export default async function ClientSectionPage({params,searchParams}:{
  params:Promise<{section:string}>;
  searchParams:Promise<{case?:string}>;
}) {
  const [{section}, query] = await Promise.all([params,searchParams]);
  const item = clientNavigation.find(([key])=>key===section && key!=="overview" && key!=="profile");
  if(!clientPortalEnabled()||!item)notFound();
  return <ClientPage section={item[0]} caseId={typeof query.case==="string"?query.case:undefined}/>;
}
