import Link from "next/link";
import { ModeBadge } from "@/components/ModeBadge";
import { ReturnBench } from "@/components/play/ReturnBench";
import styles from "@/components/play/Play.module.css";
import { formatCents } from "@/lib/format";
import { SCENARIOS, type PlayScenario, type ScenarioId } from "@/lib/play/scenarios";

const FOUR_Q: Record<PlayScenario["id"], [string, string, string, string]> = {
  camera: [
    "In this scenario, a “received” scan would release the refund, so a kit missing its lens refunds in full.",
    "Count each item into the tray, check it against the packing slip, and hold anything uncertain.",
    "The missing or swapped item is caught at the bench, before money moves, not at a restock count a week later.",
    "Unpack, read each line, and a person approves the refund. Try it on the bench above.",
  ],
  walker: [
    "Loan closets check returned walkers by eye, with no record. A walker can go back on the shelf without a rubber tip.",
    "The same rules: count each part into the tray against the loan record, and hold the walker off the shelf if anything is missing.",
    "The person harmed by a miss is the next borrower, often frail or recovering, not a store's margin.",
    "Unpack, read each line, and a volunteer signs it off. The closet's own safety check still comes after; this only checks parts came back.",
  ],
};

const Q_HEADS = ["01 · The problem", "02 · The solution", "03 · Why it matters", "04 · How it’s used"] as const;

/** /play (the camera kit) and /play/walker (ADR-009's loan closet): two static routes, one view. */
export function PlayView({ id }: { id: ScenarioId }) {
  const sc = SCENARIOS[id];
  const total = sc.items.reduce((s, i) => s + i.unitPriceCents, 0);
  const q = FOUR_Q[sc.id];
  const isWalker = sc.id === "walker";

  const intro = (
    <div className={styles.intro}>
      <span className="eyebrow">Try it yourself</span>
      <h1 className="h1">{isWalker ? "Check a walker back in" : "Return a box yourself"}</h1>
      <p className={styles.first}>Runs in your browser: app code, no model.</p>
      <p className="lead">
        {isWalker ? (
          <>
            An illustration of the same rules in a second setting: a folding walker back at a loan closet, with a made-up loan record and an illustrative{" "}
            {formatCents(total)} deposit. No closet, pilot or partner is behind it. It only checks that the parts came back.
          </>
        ) : (
          <>
            On the real bench, SAM 3.1 tracks each item and app code counts what settles in the tray. Here you move the {sc.kitName}&apos;s {sc.items.length} items (
            {formatCents(total)}) yourself, and the same app-code rules decide what a person may approve.
          </>
        )}
      </p>
      <div className={styles.introRow}>
        <nav className="row" aria-label="Setting" style={{ gap: 8 }}>
          {Object.values(SCENARIOS).map((s) => (
            <Link
              key={s.id}
              href={s.id === "camera" ? "/play" : `/play/${s.id}`}
              className={`btn btn-sm ${s.id === sc.id ? "btn-primary" : ""}`}
              aria-current={s.id === sc.id ? "page" : undefined}
            >
              {s.name}
            </Link>
          ))}
        </nav>
        <ModeBadge mode="DETERMINISTIC" title="app code in your browser; no model and no network call" />
      </div>
    </div>
  );

  return (
    <div className="container section" style={{ paddingTop: 32 }}>
      <ReturnBench key={sc.id} scenarioId={sc.id} intro={intro} />

      <section className={styles.why} aria-labelledby="why-title">
        <h2 className={`h3 ${styles.whyTitle}`} id="why-title">
          {isWalker ? "Why the same rules fit a loan closet (illustration)" : "Why this bench exists"}
        </h2>
        <dl className={styles.whyGrid}>
          {Q_HEADS.map((h, i) => (
            <div key={h}>
              <dt className="eyebrow">{h}</dt>
              <dd>{q[i]}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
