import type { Metadata } from "next";
import Link from "next/link";
import { SEEDED_SHIFT } from "@/data/shift";
import { buildRoster, runShift } from "@/lib/fleet/coordinator";
import { projectDaily } from "@/lib/fleet/projection";
import { summarizeCaching } from "@/lib/fleet/caching";
import { runAblation } from "@/lib/fleet/ablation";
import { toReplay } from "@/lib/fleet/replay";
import { loadFleetRecordings } from "@/lib/fleet/live";
import { formatCents } from "@/lib/format";
import { compareDispatch } from "@/lib/fleet/compare-dispatch";
import { AgentsAtWork } from "@/components/dash/AgentsAtWork";
import { WITHHELD_FLEET_ANSWERS } from "@/data/known-misreads";
import { publicView } from "@/lib/public/neutral-times";
import { DispatchComparison } from "@/components/dash/DispatchComparison";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Agents at work" };

export default function AgentsPage() {
  // Computed once at build time from the seeded shift.
  // Saved live Meta answers for the model roles (data/recordings/fleet/), replayed on their boxes; none = app code everywhere.
  const recorded = loadFleetRecordings(SEEDED_SHIFT.returns.map((r) => r.rma.id));
  const run = runShift(SEEDED_SHIFT, { recorded });
  const roster = buildRoster(SEEDED_SHIFT);
  const replay = toReplay(run, SEEDED_SHIFT);
  const p = projectDaily(run, roster, 500);
  const cache = summarizeCaching(recorded);
  // Each role's effect type from the frozen-output ablation over the seeded shift (the same report /dashboard/evals shows),
  // with how many boxes it changes a decision on, so a label never reads as proof about the box on screen.
  const ablation = runAblation(SEEDED_SHIFT, { recorded });
  const effects = Object.fromEntries(ablation.roles.map((r) => [r.role, { effectClass: r.effectClass, usefulBoxes: r.usefulBoxes, of: ablation.baseline.returns }]));
  const inspectors = roster.filter((a) => a.role === "inspector").length;
  const specialists = roster.length - inspectors;
  const modelRoles = roster.filter((a) => a.role !== "inspector" && a.kind === "model").length;
  // Roles that really called a model on a filmed clip: every recorded live answer (ok or not) plus the withheld one.
  const liveRoles = new Set([...Object.values(recorded).flatMap((byRole) => Object.keys(byRole ?? {})), ...WITHHELD_FLEET_ANSWERS.map((w) => w.role)]);
  // From committed data (data/known-misreads.ts), never from the recording's presence: the file itself never ships.
  const withheld = WITHHELD_FLEET_ANSWERS.filter((w) => SEEDED_SHIFT.returns.some((r) => r.rma.id === w.rmaId));
  const held = run.outcomes.filter((o) => o.lines.some((l) => l.status !== "OK")).length;
  const proposed = run.outcomes.reduce((s, o) => s + o.proposedRefundCents, 0);
  const requested = SEEDED_SHIFT.returns.reduce((s, r) => s + r.rma.requestedRefundCents, 0);
  const claims = run.outcomes.filter((o) => o.claim);
  const dispatch = compareDispatch(SEEDED_SHIFT, { recorded });

  return (
    <div className={styles.page}>
      <div className="page-head">
        <div className="stack" style={{ gap: 10 }}>
          <span className="eyebrow">Agents at work · one seeded shift, {SEEDED_SHIFT.returns.length} boxes</span>
          <h1 className="h1">Agents at work</h1>
          <p className={styles.headline}>
            {liveRoles.size} of {specialists} specialist roles called a model on the filmed clips; the {inspectors} per-box inspectors are one code path.
          </p>
          <p className={styles.lead}>
            The roles that called a model: {[...liveRoles].sort().join(", ")}. The rest ran as app code ({modelRoles} of the {specialists} are written to call a model when
            one is available). None of them can approve money: a refund needs a person&apos;s single-use token.
          </p>
          {withheld.map((w) => (
            <p key={`${w.rmaId}-${w.role}`} className={`loss-note ${styles.loss}`}>
              <span className="loss-tag">Loss</span> {w.rmaId} · {w.role}: one recorded answer withheld, {w.why}.
            </p>
          ))}
        </div>
        <span className="fixture-label">{SEEDED_SHIFT.label}</span>
      </div>

      <div className="stack" style={{ gap: 32 }}>
        <AgentsAtWork data={publicView(replay)} effects={effects} withheld={withheld} />

        <section className={`stack ${styles.shift}`} style={{ gap: 8 }} aria-labelledby="shift-title">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 className="h3" id="shift-title">
              Over the seeded shift
            </h2>
            <span className="fixture-label">{SEEDED_SHIFT.label} · counts computed by the tray counter; a person decides every refund</span>
          </div>
          <div className="kpis">
            <div className="kpi">
              <div className="v">
                {held}/{run.outcomes.length}
              </div>
              <div className="k">boxes held for a person</div>
            </div>
            <div className="kpi">
              <div className="v">{formatCents(proposed)}</div>
              <div className="k">proposed of {formatCents(requested)} requested (a proposal; a person decides)</div>
            </div>
            <div className="kpi">
              <div className="v">{claims.length}</div>
              <div className="k">carrier claims drafted ({formatCents(claims.reduce((s, o) => s + (o.claim?.claimCents ?? 0), 0))}), a person files them</div>
            </div>
            <div className="kpi">
              <div className="v">{run.outcomes.length - held}</div>
              <div className="k">boxes not held; each still waits for a person&apos;s approval</div>
            </div>
          </div>
        </section>

        <div className={styles.more}>
          <details className={styles.details}>
            <summary>Selective dispatch vs running every agent on every box (estimates on the seeded shift)</summary>
            <div className={styles.detailsBody}>
              <DispatchComparison c={publicView(dispatch)} />
            </div>
          </details>

          <details className={styles.details}>
            <summary>Prompt caching on the model roles ({cache.calls ? `from ${cache.calls} recorded live calls` : "no recorded live calls yet"})</summary>
            <section className={`stack ${styles.detailsBody}`} style={{ gap: 8 }} aria-labelledby="cache-title">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 className="h3" id="cache-title">
                  Prompt caching on the model roles
                </h2>
                <span className="fixture-label">{cache.calls ? `From ${cache.calls} recorded live calls` : "No recorded live calls on this server yet"}</span>
              </div>
              <p className="muted" style={{ margin: 0, maxWidth: "72ch", fontSize: 15 }}>
                Every model role sends its fixed instructions first and the box&apos;s evidence last, with one stable cache key per role, so Meta can serve the
                repeated prefix from its cache. Cached input costs $0.15 instead of $1.25 per million tokens on Muse Spark ($0.20 instead of $4.00 on Muse Wonder).
              </p>
              {cache.calls ? (
                <div className="kpis">
                  <div className="kpi">
                    <div className="v">{cache.cachedTokens.toLocaleString("en-US")}</div>
                    <div className="k">input tokens served from cache (cached_tokens)</div>
                  </div>
                  <div className="kpi">
                    <div className="v">{Math.round(cache.hitRate * 100)}%</div>
                    <div className="k">of {cache.inputTokens.toLocaleString("en-US")} input tokens</div>
                  </div>
                  <div className="kpi">
                    <div className="v">${cache.savedUsd.toFixed(4)}</div>
                    <div className="k">saved against the full input rate</div>
                  </div>
                  <div className="kpi">
                    <div className="v">{cache.calls}</div>
                    <div className="k">recorded live calls counted</div>
                  </div>
                </div>
              ) : (
                <p style={{ margin: 0, fontSize: 15 }}>The counts appear here from the first recorded live run of the model roles; this page never shows an estimate as a hit rate.</p>
              )}
            </section>
          </details>

          <details className={styles.details}>
            <summary>Planning projection: 500 returns a day (not a measurement)</summary>
            <section className={`stack ${styles.detailsBody}`} style={{ gap: 8 }} aria-labelledby="projection-title">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 className="h3" id="projection-title">
                  Planning projection: 500 returns a day
                </h2>
                <span className="fixture-label">Projection from the seeded shift, not a measurement</span>
              </div>
              <p className="muted" style={{ margin: 0, maxWidth: "72ch", fontSize: 15 }}>
                The seeded shift averages {p.agentsPerReturn} agent runs per box ({p.modelAgentsPerReturn} of them model roles) with selective dispatch, and an estimated ${p.usdPerReturn.toFixed(3)} per box if the model roles dispatched on each box ran live (segmentation plus model agents, at list price). Scaled to 500 boxes (the core pipeline&apos;s projection is on <Link href="/how-it-works#scale">How it works</Link>):
              </p>
              <div className="kpis">
                <div className="kpi">
                  <div className="v">{p.agentRunsPerDay.toLocaleString("en-US")}</div>
                  <div className="k">agent runs a day, projected</div>
                </div>
                <div className="kpi">
                  <div className="v">{p.namedInspectorsPerDay}</div>
                  <div className="k">inspector runs a day, one per box (one code path)</div>
                </div>
                <div className="kpi">
                  <div className="v">${p.modelUsdPerDay.toFixed(2)}</div>
                  <div className="k">estimated live model + segmentation cost a day</div>
                </div>
                <div className="kpi">
                  <div className="v">{Math.round(p.codeShare * 100)}%</div>
                  <div className="k">of agent runs are app code (no model cost)</div>
                </div>
              </div>
            </section>
          </details>
        </div>

        <section aria-labelledby="why-title" className="stack" style={{ gap: 8 }}>
          <h2 className="h3" id="why-title">
            Why these roles exist
          </h2>
          <div className="four-q">
            <div>
              <span className="eyebrow">01 · The problem</span>
              <p style={{ margin: "8px 0 0" }}>
                A returns bench sees {SEEDED_SHIFT.returns.length} boxes a shift. A missing lens cap, a swapped serial, a dent from transit, a smudged label, a late return: each needs a different check, and a tired person misses some.
              </p>
            </div>
            <div>
              <span className="eyebrow">02 · The solution</span>
              <p style={{ margin: "8px 0 0" }}>
                One inspector code path run per box (the tray counter) and {specialists} specialist roles: label, serial, damage, the lead&apos;s voice note, policy, carrier claims, restock, the customer note and cost. The coordinator merges them most-restrictive-first.
              </p>
            </div>
            <div>
              <span className="eyebrow">03 · Why it matters</span>
              <p style={{ margin: "8px 0 0" }}>
                A specialist runs on a box only when the box&apos;s evidence calls for it ({dispatch.selective.modelCalls} model calls instead of {dispatch.always.modelCalls} on the seeded shift), and a role stays only if removing it changes something (a decision, or work a person uses): the ablation on <Link href="/dashboard/evals#ablation">Evals</Link> freezes every output and removes one role at a time. Roles can raise holds and draft work; the refund still needs a person&apos;s single-use token.
              </p>
            </div>
            <div>
              <span className="eyebrow">04 · How it&apos;s used</span>
              <p style={{ margin: "8px 0 0" }}>
                The returns lead works the queues the coordinator builds: approve a clean refund, review a hold with its reasons, file the drafted carrier claim, quarantine a stray unit, send the drafted note.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
