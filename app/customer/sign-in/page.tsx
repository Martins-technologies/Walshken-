import { ClientAccess } from "@/components/walshken/client-access";
import { clientPortalEnabled } from "@/lib/walshken/client-feature";
import { CustomerAccess } from "@/components/walshken/customer-pages";

export const metadata = { title: "Customer sign in" };

export default async function CustomerSignInPage({ searchParams }: { searchParams: Promise<{ changed?: string }> }) {
  if (clientPortalEnabled()) return <ClientAccess mode="login"/>;
  return <CustomerAccess mode="sign-in" changed={(await searchParams).changed === "1"}/>;
}
