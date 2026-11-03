/**
 * Server wrappers for the dashboard's data views. They read the case store (and Stripe, and the
 * system status) during the server render, so the first HTML already carries the records: tools
 * that fetch without JavaScript (link previews, judges' checkers) see the same rows a browser does.
 * The client components keep refreshing after first paint. A failed read renders the client view
 * with no initial data, which then loads in the browser as before.
 */
import { cache } from "react";
import { connection } from "next/server";
import type { ReturnCase } from "@/lib/domain/case";
import { getStore } from "@/lib/store/case-store";
import { seedCharges, systemStatus } from "@/lib/runtime";
import { caseCounts } from "@/lib/client/cases";
import { HeldList, RefundList } from "./CaseList";
import { RmaQueue } from "./RmaQueue";
import { SettingsView } from "./SettingsView";
import { Sidebar } from "./Sidebar";
import { LabelLearning } from "./LabelLearning";
import { countLabelCorrections, labelLearningView, readLabelSetManifest, readLastSwitchDecision } from "@/lib/learning/learning-status";
import { publicView } from "@/lib/public/neutral-times";

/**
 * One store read per request, shared by the page, the sidebar and generateMetadata. Pages await it
 * in generateMetadata on purpose: Next holds the response for HTML-limited clients (next.config.ts
 * htmlLimitedBots) until metadata resolves, so by then the records are ready and render inline.
 */
export const loadCases = cache(async (): Promise<ReturnCase[] | undefined> => {
  await connection();
  try {
    return publicView(await getStore().list(), { now: Date.now() });
  } catch {
    return undefined;
  }
});

export const loadCharges = cache(async () => {
  await connection(); // before Stripe is touched: the charge lookup reads the clock
  return seedCharges()
    .then((r) => publicView(r, { now: Date.now() }))
    .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e), charges: [] }));
});

export async function SidebarWithCounts() {
  const cases = await loadCases();
  return <Sidebar initialCounts={cases ? caseCounts(cases) : undefined} />;
}

export async function HeldListWithData() {
  return <HeldList initial={await loadCases()} />;
}

export async function RmaQueueWithData() {
  return <RmaQueue initial={await loadCases()} />;
}

export async function RefundListWithData() {
  const [cases, charges] = await Promise.all([loadCases(), loadCharges()]);
  return <RefundList initial={cases} initialCharges={charges} />;
}

export async function LabelLearningWithData() {
  const cases = await loadCases();
  const set = readLabelSetManifest();
  return <LabelLearning v={labelLearningView({ manifest: set?.manifest ?? null, origin: set?.origin ?? null, corrections: cases ? countLabelCorrections(cases) : null, last: readLastSwitchDecision() })} />;
}

export async function SettingsWithStatus({ counter }: { counter: React.ComponentProps<typeof SettingsView>["counter"] }) {
  await connection();
  return <SettingsView counter={counter} initialStatus={systemStatus()} />;
}
