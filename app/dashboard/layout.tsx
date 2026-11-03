import { Suspense } from "react";
import { SidebarFallback } from "@/components/dash/Sidebar";
import { SidebarWithCounts } from "@/components/dash/server-data";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="dash">
      <Suspense fallback={<SidebarFallback />}>
        <SidebarWithCounts />
      </Suspense>
      <div className="dash-main">{children}</div>
    </div>
  );
}
