"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ModeBadge } from "@/components/ModeBadge";
import { STRIPE_TEST_LABEL } from "@/data/fixtures";
import type { LineStatus } from "@/lib/domain/schemas";
import { formatCents } from "@/lib/format";
import { announce, benchFor, initialBench, keyIntent, type BenchState, type Piece, type Place } from "@/lib/play/bench";
import { scenarioById, type ScenarioId } from "@/lib/play/scenarios";
import { PlayCounter } from "@/components/play/PlayCounter";
import styles from "@/components/play/Play.module.css";

/** The engine words its reasons for a filmed clip; here there is no clip, the visitor placed the items. */
const playDetail = (d: string) => d.replace(/ during this clip/g, " on this bench");

const ST_CLASS: Record<LineStatus, string> = { OK: "st st-ok", MISSING: "st st-missing", HELD: "st st-held", EXTRA: "st st-extra" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const sameState = (a: BenchState, b: BenchState) =>
  [...a.tray].sort().join() === [...b.tray].sort().join() &&
  [...a.standIns].sort().join() === [...b.standIns].sort().join() &&
  [...a.unreadable].sort().join() === [...b.unreadable].sort().join() &&
  a.late === b.late;

/** Top-down outline of each kit item. currentColor only, so both themes (and Dark Reader) render it. */
function ItemGlyph({ k }: { k: string }) {
  const common = { width: 56, height: 42, viewBox: "0 0 64 48", fill: "none", stroke: "currentColor", strokeWidth: 3, "aria-hidden": true } as const;
  if (k === "camera_body")
    return (
      <svg {...common}>
        <rect x="4" y="12" width="56" height="30" />
        <rect x="22" y="5" width="16" height="7" />
        <circle cx="32" cy="27" r="10" />
        <circle cx="32" cy="27" r="4" />
      </svg>
    );
  if (k === "walker_frame")
    return (
      <svg {...common}>
        <path d="M14 44 L18 8 H46 L50 44" />
        <path d="M16 26 H48" />
        <path d="M18 8 H12 M46 8 H52" />
      </svg>
    );
  if (k.startsWith("tip_"))
    return (
      <svg {...common}>
        <path d="M24 8 H40 V30 Q40 40 32 40 Q24 40 24 30 Z" />
        <path d="M22 40 H42" />
      </svg>
    );
  if (k.startsWith("glide_"))
    return (
      <svg {...common}>
        <ellipse cx="32" cy="32" rx="16" ry="8" />
        <path d="M24 30 V12 H40 V30" />
      </svg>
    );
  if (k === "lens")
    return (
      <svg {...common}>
        <circle cx="32" cy="24" r="20" />
        <circle cx="32" cy="24" r="13" />
        <circle cx="32" cy="24" r="6" />
      </svg>
    );
  return (
    <svg {...common}>
      <rect x="4" y="8" width="56" height="32" />
      <rect x="11" y="14" width="18" height="20" />
      <rect x="35" y="14" width="18" height="20" />
    </svg>
  );
}

interface DragState {
  key: string;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
}

/**
 * `intro` is the page's own heading block (rendered beside the live counter so both sit in the first screen).
 */
export function ReturnBench({ scenarioId = "camera", intro }: { scenarioId?: ScenarioId; intro?: ReactNode }) {
  const bench = useMemo(() => benchFor(scenarioById(scenarioId)), [scenarioId]);
  const { scenario: sc, slip: PLAY_SLIP, rma: PLAY_RMA, presets: PRESETS, serialised: SERIALISED_ITEMS, moveItem, pieces, placeOf, runBench, setLate, setStandIn, setUnreadable, standInSerial } = bench;
  const WINDOW_CLAUSE = sc.windowClause;
  const RETURN_WINDOW_DAYS = sc.windowDays;
  const copy = sc.copy;
  const [state, setState] = useState<BenchState>(initialBench);
  const [action, setAction] = useState("");
  const [showNext, setShowNext] = useState(false);
  const [ghost, setGhost] = useState<{ key: string; x: number; y: number; over: Place | null } | null>(null);
  const outcome = useMemo(() => runBench(state), [runBench, state]);
  const items = pieces(state);

  const boxRef = useRef<HTMLElement>(null);
  const trayRef = useRef<HTMLElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const pendingFocus = useRef<string | null>(null);

  // A moved item re-mounts in its new zone; keep keyboard focus on it.
  useEffect(() => {
    const k = pendingFocus.current;
    if (!k) return;
    pendingFocus.current = null;
    itemRefs.current.get(k)?.focus();
  }, [state]);

  const update = (next: BenchState, what: string) => {
    if (next === state) return;
    setState(next);
    setAction(what);
    setShowNext(false);
  };

  const nameOf = (key: string) => items.find((p) => p.key === key)?.name ?? key;
  const move = (key: string, to?: Place) => {
    const next = moveItem(state, key, to);
    if (next === state) return;
    update(next, `${nameOf(key)} moved to the ${placeOf(next, key) === "tray" ? "tray" : "box"}.`);
    pendingFocus.current = key;
  };

  const zoneAt = (x: number, y: number): Place | null => {
    for (const [place, ref] of [["box", boxRef], ["tray", trayRef]] as const) {
      const r = ref.current?.getBoundingClientRect();
      if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return place;
    }
    return null;
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>, key: string) => {
    suppressClick.current = false;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    drag.current = { key, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported: drag still works while the pointer stays over the item */
    }
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return;
    d.moved = true;
    setGhost({ key: d.key, x: e.clientX, y: e.clientY, over: zoneAt(e.clientX, e.clientY) });
  };
  const endDrag = (e: PointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setGhost(null);
    if (!d.moved) return;
    suppressClick.current = true;
    if (cancelled) return;
    const z = zoneAt(e.clientX, e.clientY);
    if (z && z !== placeOf(state, d.key)) move(d.key, z);
  };
  const onClick = (key: string) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    move(key);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, key: string) => {
    // Enter/Space are the button's own click (so screen-reader activation works too); arrows pick a side.
    const intent = keyIntent(e.key);
    if (intent === "to_tray" || intent === "to_box") {
      e.preventDefault();
      move(key, intent === "to_tray" ? "tray" : "box");
    }
  };

  const renderItem = (p: Piece) => {
    const place = placeOf(state, p.key);
    const other = place === "box" ? "tray" : "box";
    const label = [
      p.name,
      formatCents(p.unitPriceCents),
      p.requiresSerial ? (p.labelUnreadable ? "serial label unreadable" : `serial label ${p.labelText}`) : null,
      `in the ${place}`,
      `press to move it to the ${other}`,
    ]
      .filter(Boolean)
      .join(", ");
    return (
      <li key={p.key}>
        <button
          type="button"
          className="play-item"
          data-place={place}
          data-dragging={ghost?.key === p.key || undefined}
          aria-label={label}
          aria-describedby="play-help"
          ref={(el) => {
            if (el) itemRefs.current.set(p.key, el);
            else itemRefs.current.delete(p.key);
          }}
          onClick={() => onClick(p.key)}
          onKeyDown={(e) => onKeyDown(e, p.key)}
          onPointerDown={(e) => onPointerDown(e, p.key)}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endDrag(e, false)}
          onPointerCancel={(e) => endDrag(e, true)}
        >
          <span className="play-item-top">
            <ItemGlyph k={p.key} />
            {p.isStandIn && <span className="play-tag">look-alike</span>}
          </span>
          <span className="play-item-name">{p.name}</span>
          <span className="mono muted play-item-price">{formatCents(p.unitPriceCents)}</span>
          {p.requiresSerial && (
            <span className="play-label" data-unreadable={p.labelUnreadable || undefined}>
              {p.labelUnreadable ? "▒▒-▒▒-▒▒▒▒▒" : p.labelText}
            </span>
          )}
          <span className="play-item-cta" aria-hidden>
            {place === "box" ? "To tray →" : "← Back to box"}
          </span>
        </button>
      </li>
    );
  };

  const inBox = items.filter((p) => placeOf(state, p.key) === "box");
  const inTray = state.tray.map((k) => items.find((p) => p.key === k)!).filter(Boolean);
  const { recon, settlement, bounds, window: win, approvable, holdReasons, count } = outcome;
  const partial = settlement.options.find((o) => o.key === "partial")!;
  const recommended = settlement.options.find((o) => o.key === settlement.recommended)!;
  const ghostPiece = ghost ? items.find((p) => p.key === ghost.key) : undefined;
  const seenCents = inTray.reduce((s, p) => s + p.unitPriceCents, 0);
  const requestedCents = outcome.rma.requestedRefundCents;
  const noun = sc.id === "walker" ? "deposit" : "requested refund";
  const caseHolds = (recon.policyHolds ?? []).map((h) => `Return window (clause ${h.clauseId}): a person checks the delivery date`);
  const trickyActive = state.standIns.length > 0 || state.unreadable.length > 0 || state.late;
  const [trickyOpen, setTrickyOpen] = useState(false);
  const announcement = action
    ? `${action} ${formatCents(seenCents)} seen of the ${formatCents(requestedCents)} ${noun}. ${announce(outcome, formatCents, sc.id === "walker" ? "deposit back" : "refund")}`
    : "";

  return (
    <>
    <div className={styles.top}>
      {intro}
      <div className={styles.counterWrap}>
        <PlayCounter
          seenCents={seenCents}
          requestedCents={requestedCents}
          lines={recon.lines}
          caseHolds={caseHolds}
          complete={approvable}
          setting={sc.id}
          announcement={announcement}
        />
      </div>
    </div>
    <div className="play-layout">
      {/* ---------------- Bench + controls ---------------- */}
      <section className="stack" style={{ gap: 20 }} aria-labelledby="bench-title">
        <div className="stack" style={{ gap: 6 }}>
          <span className="eyebrow">
            {copy.operator} · {PLAY_RMA.id}
          </span>
          <h2 className="h2" id="bench-title">
            The bench, seen from above
          </h2>
          <p id="play-help" className={styles.help}>
            Tap &ldquo;To tray&rdquo; or drag an item. Keyboard: Enter or Space moves it, Arrow Right to the tray, Arrow Left back to the box.
          </p>
        </div>

        <div className={`play-bench ${styles.bench}`}>
          <section ref={boxRef} className="play-zone play-box" data-over={ghost?.over === "box" || undefined} aria-labelledby="zone-box">
            <h3 id="zone-box" className="play-zone-title">
              <span>The open box</span>
              <span className="mono">{inBox.length} inside</span>
            </h3>
            {inBox.length ? (
              <ul className="play-items">{inBox.map(renderItem)}</ul>
            ) : (
              <p className="play-empty">Empty. Nothing left in the box.</p>
            )}
          </section>
          <section ref={trayRef} className="play-zone play-tray" data-over={ghost?.over === "tray" || undefined} aria-labelledby="zone-tray">
            <h3 id="zone-tray" className="play-zone-title">
              <span>Inspected tray</span>
              <span className="mono">
                {inTray.length} of {PLAY_SLIP.lines.length} counted
              </span>
            </h3>
            {inTray.length ? (
              <ul className="play-items">{inTray.map(renderItem)}</ul>
            ) : (
              <p className="play-empty">Nothing counted yet. An item counts once it settles here.</p>
            )}
          </section>
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <span className="eyebrow" id="presets-label">
            Try a case
          </span>
          <div className="row" role="group" aria-labelledby="presets-label" style={{ gap: 8 }}>
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="btn btn-sm"
                aria-pressed={sameState(state, p.state)}
                onClick={() => update(p.state, `Case loaded: ${p.label.toLowerCase()}.`)}
              >
                {p.label}
              </button>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => update(initialBench(), "Bench reset. Everything is back in the box.")}>
              Reset
            </button>
          </div>
        </div>

        <details className={styles.tricky} open={trickyOpen || trickyActive} onToggle={(e) => setTrickyOpen(e.currentTarget.open)}>
          <summary>
            Make it tricky <span>{WINDOW_CLAUSE ? "look-alikes, unreadable labels, a late return" : "another closet's walker, an unreadable tag"}</span>
          </summary>
        <fieldset className="play-options" aria-label="Make it tricky">
          <p className="muted" style={{ margin: "0 0 4px", fontSize: 15 }}>
            Leaving an item in the box is the first trick. These are the others the engine knows about.
          </p>
          {SERIALISED_ITEMS.map((item) => (
            <div className="play-opt-row" key={item.key} role="group" aria-label={item.name}>
              <span className="play-opt-name">{item.name}</span>
              <label className="touch-option">
                <input
                  type="checkbox"
                  checked={state.standIns.includes(item.key)}
                  onChange={(e) =>
                    update(
                      setStandIn(state, item.key, e.target.checked),
                      e.target.checked ? `${item.name} swapped for a look-alike with ${copy.labelNoun} ${standInSerial(item)}.` : `The real ${item.name.toLowerCase()} is back.`,
                    )
                  }
                />
                <span>
                  {copy.lookAlike} <span className="mono muted">({copy.labelNoun} {standInSerial(item)})</span>
                </span>
              </label>
              <label className="touch-option">
                <input
                  type="checkbox"
                  checked={state.unreadable.includes(item.key)}
                  onChange={(e) =>
                    update(
                      setUnreadable(state, item.key, e.target.checked),
                      e.target.checked ? `${item.name} label marked unreadable.` : `${item.name} label readable again.`,
                    )
                  }
                />
                <span>{copy.labelNoun === "serial" ? "Serial label" : "Asset tag"} can&apos;t be read</span>
              </label>
            </div>
          ))}
          {WINDOW_CLAUSE && (
          <div className="play-opt-row" role="radiogroup" aria-labelledby="date-label">
            <span className="play-opt-name" id="date-label">
              Return started
            </span>
            <label className="touch-option">
              <input type="radio" name="play-date" checked={!state.late} onChange={() => update(setLate(state, false), `Return date set inside the ${RETURN_WINDOW_DAYS}-day window.`)} />
              <span>Inside the {RETURN_WINDOW_DAYS}-day window</span>
            </label>
            <label className="touch-option">
              <input type="radio" name="play-date" checked={state.late} onChange={() => update(setLate(state, true), `Return date set outside the ${RETURN_WINDOW_DAYS}-day window.`)} />
              <span>Outside it (late)</span>
            </label>
          </div>
          )}
        </fieldset>
        </details>
        <p className="fixture-label" style={{ margin: 0 }}>
          {copy.fixtureLabel}
        </p>
      </section>

      {/* ---------------- What the engine says ---------------- */}
      <section className="stack" style={{ gap: 20 }} aria-labelledby="result-title">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
          <h2 className="h2" id="result-title">
            What the engine decides
          </h2>
          <ModeBadge mode="DETERMINISTIC" title="reconcile() and calculateSettlement() from lib/engine/reconcile.ts, running in your browser" />
        </div>

        {approvable ? (
          <div className="play-banner">
            <span className="sticker-ok lg">COMPLETE</span>
            <p style={{ margin: 0 }}>{copy.completeLine}</p>
          </div>
        ) : (
          <div className="play-banner" data-held>
            <span className="sticker-held lg">HELD</span>
            <div className="stack" style={{ gap: 4 }}>
              <strong>Why it&apos;s held</strong>
              <ul className="play-reasons">
                {holdReasons.map((r) => (
                  <li key={r}>{playDetail(r)}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <div className={`table-wrap ${styles.slip}`}>
          <table className="table">
            <caption className="sr-only">Packing slip versus what is in the tray, per line, with the engine&apos;s status and reason</caption>
            <thead>
              <tr>
                <th scope="col">Packing slip</th>
                <th scope="col" className="num">
                  Tray
                </th>
                <th scope="col">Status</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {recon.lines.map((l) => {
                const slipLine = PLAY_SLIP.lines.find((s) => s.itemKey === l.itemKey);
                return (
                  <tr key={l.itemKey}>
                    <td>
                      <strong>{l.description}</strong>
                      <div className="mono muted" style={{ fontSize: 13 }}>
                        {formatCents(l.unitPriceCents)}
                        {slipLine?.serial ? ` · ${slipLine.serial}` : ""}
                      </div>
                    </td>
                    <td className="num mono">
                      {l.observedQty}/{l.expectedQty}
                    </td>
                    <td>
                      <span className={ST_CLASS[l.status]}>{l.status}</span>
                    </td>
                    <td style={{ fontSize: 14 }}>
                      {l.reasons.map((r, i) => (
                        <div key={i}>{playDetail(r.detail)}</div>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="play-refund">
          <div className="play-refund-cell">
            <span className="eyebrow">{copy.fullLabel}</span>
            <span className="play-amount tnum">{formatCents(bounds.fullCents)}</span>
            <span className="muted" style={{ fontSize: 14 }}>
              {approvable ? "A person can approve this." : "Not on a held box, unless a person writes an override reason."}
            </span>
          </div>
          <div className="play-refund-cell">
            <span className="eyebrow">{copy.partialLabel}</span>
            <span className="play-amount tnum">{partial.available ? formatCents(partial.refundCents) : "—"}</span>
            <span className="muted" style={{ fontSize: 14 }}>
              {partial.available
                ? `${formatCents(partial.heldCents)} stays held. ${copy.partialWhy}`
                : approvable
                  ? "Not needed: the box is complete."
                  : "Not offered: no line is clear enough to refund on its own."}
            </span>
          </div>
        </div>
        <p style={{ margin: 0, fontSize: 15 }}>
          <span className="eyebrow">Engine recommends</span> <strong>{copy.options[recommended.key]}</strong>
          <span className="muted">
            {" "}
            (clause {recommended.clause}).{" "}
            {recommended.available ? "It recommends; it never picks." : "That option isn't open on this box: nothing in the tray is clear enough to release yet, so it stays on hold."}
          </span>
        </p>

        {WINDOW_CLAUSE && win ? (
        <div className={`clause ${styles.clause}`}>
          <span className="clause-id">
            CLAUSE {WINDOW_CLAUSE.id} · {WINDOW_CLAUSE.title.toUpperCase()}
          </span>{" "}
          {WINDOW_CLAUSE.text}
          <div style={{ marginTop: 6 }}>
            Return started {fmtDate(win.returnDate)}, {win.daysAfterShip} days after the order shipped. The clause counts from delivery, and the
            delivery date isn&apos;t on record; delivery always comes after shipping.{" "}
            {win.outside ? (
              <strong>So the return may be past {win.limitDays} days from delivery: the box holds and a person checks the delivery date before any refund, even if every item is fine.</strong>
            ) : (
              <span className="muted">So it is inside {win.limitDays} days from delivery too, and the date raises no hold.</span>
            )}
          </div>
        </div>
        ) : copy.hardLimit ? (
          <div className={`clause ${styles.clause}`} role="note">
            <span className="clause-id">CLAUSE 7.1 · NOT A SAFETY CHECK</span> {copy.hardLimit}
          </div>
        ) : null}

        <div className="card stack" style={{ gap: 12 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3 className="h3">A person decides</h3>
            {sc.id === "camera" && <span className="fixture-label">{STRIPE_TEST_LABEL}</span>}
          </div>
          <div className="row">
            <button type="button" className="btn btn-accent" disabled={!approvable} aria-describedby="approve-note" onClick={() => setShowNext(true)}>
              {copy.approveVerb}{approvable ? ` · ${formatCents(bounds.fullCents)}` : ""}
            </button>
          </div>
          <p id="approve-note" style={{ margin: 0 }}>
            {sc.id === "walker" ? "A volunteer signs off every return; a held item never goes back on the shelf by itself." : "A person approves every refund; a held box never refunds by itself."}
          </p>
          {!approvable && partial.available && (
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              In the dashboard a person could still choose the {formatCents(partial.refundCents)} partial amount, with the evidence open. Here the button stays off.
            </p>
          )}
          {showNext && approvable && (
            <div className="well stack" style={{ gap: 8 }} role="region" aria-live="polite" aria-label="What would happen next">
              <strong>What would happen next (nothing was sent from this page)</strong>
              <ol className="play-next">
                {copy.nextSteps(formatCents(bounds.fullCents)).map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ol>
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>
                This page makes no network calls. <Link href="/demo">The Instant Demo</Link> runs the real approval and Stripe test refund.
              </p>
            </div>
          )}
        </div>

        <details>
          <summary>The counter output the engine read</summary>
          <p className="muted" style={{ fontSize: 14, margin: "8px 0" }}>
            Your tray, written in the same CountResult shape the bench&apos;s tray counter builds from SAM 3.1&apos;s tracks. No SAM ran here: you placed the items, and app code read them. Policy {sc.policy.version}.
          </p>
          <pre className="json">{JSON.stringify({ counts: count.counts, arrivals: count.arrivals.map((a) => ({ itemKey: a.itemKey, t: a.t, label: a.label?.text ?? null })), flags: count.flags.map((f) => ({ code: f.code, itemKeys: f.itemKeys, detail: f.detail })) }, null, 2)}</pre>
        </details>
      </section>

      {ghost && ghostPiece && (
        <div className="play-ghost" style={{ left: ghost.x, top: ghost.y }} aria-hidden>
          <ItemGlyph k={ghostPiece.key} />
          <span>{ghostPiece.name}</span>
        </div>
      )}
    </div>
    </>
  );
}
