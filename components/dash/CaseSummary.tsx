import type { ReturnCase } from "@/lib/domain/case";
import { formatCents } from "@/lib/format";
import { misreadsFor, misreadsIn } from "@/data/known-misreads";
import { fromFilmedClip } from "@/lib/domain/schemas";
import { KnownMisreadsBanner, LossNotes } from "./LossNotes";
import styles from "./CaseSummary.module.css";

const STATE_TEXT: Record<string, string> = { Held: "HELD", AwaitingApproval: "waits for a person", Approved: "approved by a person", Refunded: "refunded once", Received: "received" };

/**
 * The decision first, above the replay: what was counted, why the refund is held, the known misreads (as losses, beside
 * the statements they correct) and who can release it. The full evidence (replay, diagnostics, readers, trace) follows.
 */
export function CaseSummary({ c, requestedCents }: { c: ReturnCase; requestedCents?: number }) {
  const lines = c.reconciliation?.lines ?? [];
  // The filmed run's known misreads belong only to a case decided on that run, not to a synthetic scene of the same RMA.
  const clipId = fromFilmedClip(c.clip) ? c.clip.clipId : undefined;
  const held = c.state === "Held";
  return (
    <section className={styles.summary} aria-labelledby="case-summary-title">
      <div className={styles.head}>
        <h2 className="h2" id="case-summary-title">
          {requestedCents != null ? formatCents(requestedCents) : "Refund"} <span className={held ? styles.held : styles.state}>{STATE_TEXT[c.state] ?? c.state}</span>
        </h2>
        <p className={styles.release}>
          Only a person can release it: a typed-name, single-use approval bound to this evidence. A model can raise a hold, never clear one.
        </p>
      </div>
      <ul className={styles.lines} aria-label="What was counted">
        {lines.map((l) => {
          const why = l.status === "OK" ? [] : l.reasons.filter((r) => r.code !== "count_match");
          return (
            <li key={l.itemKey} className={styles.line} data-status={l.status}>
              <span className={styles.item}>{l.description}</span>
              <span className={styles.count}>
                {l.observedQty}/{l.expectedQty}
              </span>
              <span className={l.status === "OK" ? "st st-ok" : "st st-held"}>{l.status === "OK" ? "OK" : l.status === "MISSING" ? "Missing" : "Held"}</span>
              {why.length > 0 && (
                <div className={styles.why}>
                  {why.slice(0, 2).map((r) => (
                    <div key={r.code + r.detail}>
                      {r.detail}
                      <LossNotes items={misreadsIn(clipId, r.detail, l.itemKey)} compact />
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <KnownMisreadsBanner items={misreadsFor(clipId)} />
    </section>
  );
}
