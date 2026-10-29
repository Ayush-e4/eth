import { Suspense } from "react";
import { Sidebar } from "@/components/shell/Sidebar";
import { SessionProvider } from "@/lib/session";

/** Everything behind sign-in: sidebar on the left, the page on the right (stacked on phones). */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <SessionProvider>
      <div className="flex min-h-dvh flex-wrap md:flex-nowrap">
        {/* The sidebar reads the URL, which only exists at request time. */}
        <Suspense
          fallback={
            <aside
              aria-label="Sidebar"
              className="flex-[1_1_264px] border-r border-line bg-side md:max-w-[300px]"
            />
          }
        >
          <Sidebar />
        </Suspense>
        <div className="flex min-w-0 flex-[999_1_560px] flex-col">{children}</div>
      </div>
    </SessionProvider>
  );
}
