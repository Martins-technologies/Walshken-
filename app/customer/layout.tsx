import { clientPortalEnabled } from "@/lib/walshken/client-feature";
import { PublicShell } from "@/components/walshken/public-shell";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function CustomerLayout({ children }: { children: ReactNode }) {
  if (clientPortalEnabled()) return children;
  return <PublicShell>{children}</PublicShell>;
}
