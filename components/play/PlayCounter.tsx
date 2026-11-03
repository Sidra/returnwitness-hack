"use client";

import { useEffect, useRef, useState } from "react";
import type { LineStatus, Reconciliation } from "@/lib/domain/schemas";
import { formatCents } from "@/lib/format";
import styles from "./PlayCounter.module.css";

const ST_CLASS: Record<LineStatus, string> = { OK: "st st-ok", MISSING: "st st-missing", HELD: "st st-held", EXTRA: "st st-extra" };

/** Eases a number toward `target` with requestAnimationFrame; jumps straight there under prefers-reduced-motion. */
function useTweened(target: number, ms = 420): number {
  const [shown, setShown] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    const start = current.current;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    if (reduce || start === target) {
      raf = requestAnimationFrame(() => {
        current.current = target;
        setShown(target);
      });
      return () => cancelAnimationFrame(raf);
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      current.current = start + (target - start) * eased;
      setShown(current.current);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return shown;
}

export interface PlayCounterProps {
  /** Sum of the unit prices of the items sitting in the tray: presence only, not identity or condition. */
  seenCents: number;
  /** What the return asks for (the RMA's requested refund, or the walker's deposit). Kept apart from seen value. */
  requestedCents: number;
  lines: Reconciliation["lines"];
  /** Case-level holds that are not a line (the return window), already in plain words. */
  caseHolds: string[];
  /** True only when every line is OK and no case-level hold stands. */
  complete: boolean;
  setting: "camera" | "walker";
  /** The live-region sentence for the last change ("" before the first one). */
  announcement: string;
}

const WORDS = {
  camera: {
    eyebrow: "Value seen in the tray",
    of: (amount: string) => (
      <>
        seen of <strong className="tnum">{amount}</strong> requested refund
      </>
    ),
    held: (
      <>
        <strong>Waits for a person.</strong> HELD is not a denial: a person reviews what the check flagged and decides.
      </>
    ),
    complete: (
      <>
        <strong>Complete is not a refund.</strong> Every line is clear, and it still waits for a person&apos;s approval.
      </>
    ),
  },
  walker: {
    eyebrow: "Parts seen in the tray · illustrative prices",
    of: (amount: string) => (
      <>
        seen of the <strong className="tnum">{amount}</strong> deposit (illustrative)
      </>
    ),
    held: (
      <>
        <strong>Stays off the shelf until a volunteer looks.</strong> A hold is not a charge (clause 5.1).
      </>
    ),
    complete: (
      <>
        <strong>Every part is back.</strong> A volunteer still signs it off, and the closet&apos;s own safety check comes next.
      </>
    ),
  },
} as const;

/**
 * The big, reactive number on /play: what has been seen in the tray against what the return asks for, with the
 * HELD / complete state beside it. Pure display: the verdict itself comes from the engine (lib/play/bench.ts).
 */
export function PlayCounter({ seenCents, requestedCents, lines, caseHolds, complete, setting, announcement }: PlayCounterProps) {
  const w = WORDS[setting];
  const shown = useTweened(seenCents);

  // Direction of the last change, kept just long enough for the colour tick (CSS transitions do the motion).
  const [prev, setPrev] = useState(seenCents);
  const [tick, setTick] = useState<{ dir: "up" | "down"; delta: number; n: number } | null>(null);
  const [lastDelta, setLastDelta] = useState(0);
  if (prev !== seenCents) {
    setPrev(seenCents);
    setLastDelta(seenCents - prev);
    setTick((t) => ({ dir: seenCents > prev ? "up" : "down", delta: seenCents - prev, n: (t?.n ?? 0) + 1 }));
  }
  useEffect(() => {
    if (!tick) return;
    const id = window.setTimeout(() => setTick(null), 900);
    return () => window.clearTimeout(id);
  }, [tick]);

  const slipTotal = lines.reduce((s, l) => s + l.unitPriceCents * l.expectedQty, 0) || 1;
  const clear = lines.filter((l) => l.status === "OK").length;
  const open = lines.filter((l) => l.status !== "OK");
  const deltaText = lastDelta === 0 ? "" : `${lastDelta > 0 ? "+" : "−"}${formatCents(Math.abs(lastDelta))}`;

  return (
    <section className={styles.counter} aria-labelledby="play-counter-title" data-complete={complete || undefined}>
      <div className={styles.figure}>
        <h2 className={`eyebrow ${styles.eyebrow}`} id="play-counter-title">
          {w.eyebrow}
        </h2>
        <div className={styles.numberRow}>
          <span className={`${styles.number} tnum`} data-dir={tick?.dir} aria-hidden>
            {formatCents(Math.round(shown / 100) * 100)}
          </span>
          <span className={`${styles.delta} mono`} data-show={tick ? true : undefined} data-dir={lastDelta > 0 ? "up" : "down"} aria-hidden>
            {deltaText}
          </span>
        </div>
        <p className={styles.of}>
          <span className="sr-only">{formatCents(seenCents)} </span>
          {w.of(formatCents(requestedCents))}
        </p>
        <div className={styles.bar} aria-hidden>
          {lines.map((l) => (
            <span key={l.itemKey} className={styles.seg} style={{ flexGrow: (l.unitPriceCents * l.expectedQty) / slipTotal }} title={`${l.description}: ${l.status}`}>
              <span className={styles.fill} data-status={l.status} data-seen={l.observedQty > 0 || undefined} />
            </span>
          ))}
        </div>
        <p className={styles.clear}>
          <span className="mono tnum">
            {clear} of {lines.length}
          </span>{" "}
          {setting === "walker" ? "parts clear on the loan record" : "lines clear on the packing slip"}
        </p>
      </div>

      <div className={styles.state}>
        {complete ? <span className="sticker-ok">COMPLETE</span> : <span className="sticker-held">HELD</span>}
        <p className={styles.stateLine}>{complete ? w.complete : w.held}</p>
        {(open.length > 0 || caseHolds.length > 0) && (
          <ul className={styles.open} aria-label="What holds it">
            {open.map((l) => (
              <li key={l.itemKey}>
                <span>{l.description}</span> <span className={ST_CLASS[l.status]}>{l.status === "MISSING" ? "MISSING · HELD" : l.status}</span>
              </li>
            ))}
            {caseHolds.map((h) => (
              <li key={h}>
                <span>{h}</span> <span className="st st-held">HELD</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  );
}
