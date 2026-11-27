import { notFound } from "next/navigation";
import { ClientAccess } from "@/components/walshken/client-access";
import { clientPortalEnabled } from "@/lib/walshken/client-feature";
export const metadata = {title:"Reset your client password"};
export default function Reset() {
  if(!clientPortalEnabled())notFound();
  return <ClientAccess mode="reset"/>;
}
