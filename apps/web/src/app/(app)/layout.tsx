import { AppShell } from "@/components/shell/AppShell";
import { SessionProvider } from "@/lib/session";

/** Everything behind sign-in: the sidebar beside the page (a drawer on phones). */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <SessionProvider>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
