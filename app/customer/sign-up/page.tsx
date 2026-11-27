import { ClientAccess } from "@/components/walshken/client-access";
import { clientPortalEnabled } from "@/lib/walshken/client-feature";
import { CustomerAccess } from "@/components/walshken/customer-pages";

export const metadata = { title: "Create a customer account" };

export default function CustomerSignUpPage() {
  if (clientPortalEnabled()) return <ClientAccess mode="register"/>;
  return <CustomerAccess mode="sign-up"/>;
}
