import type { Metadata } from "next";
import { Suspense } from "react";
import { SettingsView } from "@/components/dash/SettingsView";
import { SettingsWithStatus, loadCases } from "@/components/dash/server-data";
import { COUNTER_CONFIG } from "@/lib/runtime";

// Awaits the sidebar's store read so HTML-limited clients get the counts inline (see server-data.tsx).
export async function generateMetadata(): Promise<Metadata> {
  await loadCases();
  return { title: "Settings" };
}

export default function SettingsPage() {
  const c = COUNTER_CONFIG;
  const counter = { tray: c.trayZone, box: c.boxZone, settleFrames: c.settleFrames, settleMotion: c.settleMotion, mergeAreaRatio: c.mergeAreaRatio, slotIoU: c.slotIoU };
  return (
    <>
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <span className="eyebrow">Bench 2</span>
          <h1 className="h1">Settings</h1>
        </div>
      </div>
      <Suspense fallback={<SettingsView counter={counter} />}>
        <SettingsWithStatus counter={counter} />
      </Suspense>
    </>
  );
}
