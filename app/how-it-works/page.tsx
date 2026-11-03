import type { Metadata } from "next";
import Link from "next/link";
import { ModeBadge, replayText } from "@/components/ModeBadge";
import { HeldBoundary } from "@/components/marketing/HeldBoundary";
import { ScaleSection } from "@/components/marketing/ScaleSection";
import { EvidenceFlow, type FlowNote, type FlowStep } from "@/components/marketing/EvidenceFlow";
import { KIT, KIT_TOTAL_CENTS, kitItem } from "@/data/kit.config";
import { MERCHANT, RMAS } from "@/data/fixtures";
import { AB_RUN_NOTES, misreadsIn } from "@/data/known-misreads";
import { formatCents } from "@/lib/format";
import { loadRecording } from "@/lib/meta/recordings";
import { loadFleetRecordings } from "@/lib/fleet/live";
import { countClip } from "@/lib/vision/tray-counter";
import { REAL_FOOTAGE_COUNTER_CONFIG } from "@/lib/runtime";
import { GLIMMER_TIMEOUT_MS } from "@/lib/openweights/glimmer";
import { AGENT_LIMITS } from "@/lib/engine/agent-limits";
import { MODE_TEXT, REAL_REPLAY_TEXT, type LineStatus, type SegmentationResult } from "@/lib/domain/schemas";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "How it works · ReturnWitness",
  description:
    "Segment, count, reconcile, draft, approve, refund: the pipeline behind a held refund, the state machine, the approval token, and an honest status table.",
};

/* ---------- The six jobs, from the recorded real run on my two filmed returns ---------- */

interface SparkRec { lines: Array<{ itemKey: string; status: LineStatus; observedQty: number }> }
interface AuditRec { provider: string; model: string; audit: { items: Array<{ itemKey: string; standInSuspected: boolean; visibleDamage: boolean; labelLegible: boolean; note: string }> } }
interface LabelsRec { provider: string; model: string; read: { items: Array<{ itemKey: string; serialRead: string | null; legible: boolean; confidence: number }> } }
interface WonderRec { model: string; latencyMs: number; requestIds: string[]; draft: { recommendation: string; citedClauses: Array<{ clauseId: string; quote: string }>; rationale: string } }

const secs1 = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const itemName = (key: string) => kitItem(key)?.name ?? key;
const firstSentence = (t: string) => (t.match(/^.*?[.!?](\s|$)/)?.[0] ?? t).trim();

/**
 * Everything on the flow's steps is read from the committed recordings (data/recordings/), or
 * computed from them by the same app code the bench runs. A recording that is missing leaves its step without a number.
 */
function buildFlow(): { steps: FlowStep[]; d2FalseHold: boolean } {
  const clips = RMAS.filter((r) => r.id === "RMA-20418" || r.id === "RMA-20419").map((r) => ({ rma: r, short: r.id === "RMA-20418" ? "d1" : "d2", what: r.id === "RMA-20418" ? "lens missing" : "complete kit" }));
  const fleet = loadFleetRecordings(clips.map((c) => c.rma.id));
  const rec = clips.map((c) => {
    const sam = loadRecording<SegmentationResult>(c.rma.clipId, "sam")?.data ?? null;
    const spark = loadRecording<SparkRec>(c.rma.clipId, "spark");
    return {
      ...c,
      sam,
      count: sam ? countClip(c.rma.clipId, sam.frames, { ...REAL_FOOTAGE_COUNTER_CONFIG, checkLabels: false }) : null,
      spark: spark ? { ...spark.data, meta: spark.meta } : null,
      audit: loadRecording<AuditRec>(c.rma.clipId, "audit")?.data ?? null,
      labels: loadRecording<LabelsRec>(c.rma.clipId, "labels")?.data ?? null,
      wonder: loadRecording<WonderRec>(c.rma.clipId, "wonder")?.data ?? null,
      policy: fleet[c.rma.id]?.["policy-agent"] ?? null,
    };
  });

  const samFacts = rec.flatMap((r) => {
    const ms = r.sam?.source.provenance.match(/(\d+) ms/)?.[1];
    return r.sam && ms ? [{ value: secs1(Number(ms)), label: `${r.short} · ${Math.round(r.sam.durationS)} s clip, ${r.what}`, source: `measured: ${r.sam.source.provenance}` }] : [];
  });

  const countFacts = rec.flatMap((r) =>
    r.count
      ? [{
          value: `${KIT.items.filter((i) => (r.count!.counts[i.key] ?? 0) >= 1).length} of ${KIT.items.length}`,
          label: `${r.short} · items counted in the tray`,
          source: `${KIT.items.map((i) => `${i.name} ${r.count!.counts[i.key] ?? 0}/1`).join(" · ")}. Computed by the tray counter on the recorded SAM 3.1 tracks.`,
        }]
      : [],
  );

  const readerNotes: FlowNote[] = [];
  for (const r of rec) {
    if (r.spark) {
      const bad = r.spark.lines.filter((l) => l.status !== "OK");
      readerNotes.push({
        who: `Muse Spark 1.3 · ${r.short}`,
        text: bad.length ? bad.map((l) => `${itemName(l.itemKey)} ${l.status}`).join("; ") + "; every other line OK." : "Every line OK.",
        provenance: <span className="mode mode-fixture">{replayText({ model: r.spark.meta?.model ?? "muse-spark-1.3", requestId: r.spark.meta?.requestId, at: "" })}</span>,
      });
    }
  }
  for (const r of rec) {
    const flagged = r.audit?.audit.items.filter((i) => i.standInSuspected || i.visibleDamage) ?? [];
    for (const i of flagged) {
      readerNotes.push({
        who: `Open-weight auditor · ${r.short}`,
        text: <>Flagged the {itemName(i.itemKey).toLowerCase()} {i.standInSuspected ? "as a stand-in" : "as damaged"}: &ldquo;{i.note}&rdquo;</>,
        misreads: misreadsIn(r.rma.clipId, i.note, i.itemKey),
        provenance: <span className="mode mode-fixture">{replayText({ model: `${r.audit!.model} on ${r.audit!.provider === "baseten" ? "Baseten" : r.audit!.provider}`, at: "" })}</span>,
      });
    }
    // The other direction: an item the auditor passed that is a known miss (the lens-shaped mug on d2).
    const passedMisses = r.audit?.audit.items.filter((i) => !i.standInSuspected && !i.visibleDamage && misreadsIn(r.rma.clipId, i.note, i.itemKey).length) ?? [];
    for (const i of passedMisses) {
      readerNotes.push({
        who: `Open-weight auditor · ${r.short}`,
        text: <>Passed the {itemName(i.itemKey).toLowerCase()}: &ldquo;{i.note}&rdquo;</>,
        misreads: misreadsIn(r.rma.clipId, i.note, i.itemKey),
        provenance: <span className="mode mode-fixture">{replayText({ model: `${r.audit!.model} on ${r.audit!.provider === "baseten" ? "Baseten" : r.audit!.provider}`, at: "" })}</span>,
      });
    }
  }
  for (const r of rec) {
    if (r.labels) {
      const read = r.labels.read.items.map((i) => (i.legible && i.serialRead ? `${itemName(i.itemKey)} serial ${i.serialRead}` : `${itemName(i.itemKey)} label unreadable`));
      readerNotes.push({
        who: `Glimmer · ${r.short}`,
        text: `Read: ${read.join("; ")}.`,
        provenance: <span className="mode mode-fixture">{replayText({ model: `${r.labels.model} on ${r.labels.provider === "modal" ? "Modal" : r.labels.provider}`, at: "" })}</span>,
      });
    } else if (r.sam) {
      const note = Object.values(AB_RUN_NOTES).find((n) => n.includes(`Glimmer timed out on ${r.short}`));
      readerNotes.push({
        who: `Glimmer · ${r.short}`,
        text: "No answer in the recorded run, so this replay has no label read from it.",
        losses: note ? [`Glimmer timed out on ${r.short} (its ${GLIMMER_TIMEOUT_MS / 1000} s budget): that run lost its label read.`] : undefined,
      });
    }
  }

  const merged = rec.map((r) => {
    const held = [
      ...KIT.items.filter((i) => (r.count?.counts[i.key] ?? 0) < 1).map((i) => `${i.name.toLowerCase()} not counted`),
      ...(r.spark?.lines.filter((l) => l.status !== "OK").map((l) => `Spark: ${itemName(l.itemKey).toLowerCase()} ${l.status}`) ?? []),
      ...(r.audit?.audit.items.filter((i) => i.standInSuspected || i.visibleDamage).map((i) => `auditor: ${itemName(i.itemKey).toLowerCase()} ${i.standInSuspected ? "stand-in" : "damage"}`) ?? []),
    ];
    const allCounted = KIT.items.every((i) => (r.count?.counts[i.key] ?? 0) >= 1);
    return { r, held, allCounted };
  });
  const d2 = merged.find((m) => m.r.short === "d2");
  const d2FalseHold = !!d2 && d2.allCounted && d2.held.length > 0;

  const wonderFacts = rec.flatMap((r) => (r.wonder ? [{ value: secs1(r.wonder.latencyMs), label: `${r.short} · Muse Wonder 1.0 agent run`, source: `measured: live run, tool loop included (${r.wonder.requestIds.length} calls), inside its ${AGENT_LIMITS.deadlineMs / 1000} s deadline` }] : []));
  const wonderNotes: FlowNote[] = rec.flatMap((r) => {
    if (!r.wonder) return [];
    const clause = r.wonder.draft.citedClauses[0];
    const sentence = firstSentence(r.wonder.draft.rationale);
    return [{
      who: `Muse Wonder draft · ${r.short}`,
      text: <>Drafted {r.wonder.draft.recommendation}, citing clause {clause?.clauseId} (&ldquo;{clause?.quote}&rdquo;). Its reason: &ldquo;{sentence}&rdquo;</>,
      misreads: misreadsIn(r.rma.clipId, sentence),
      provenance: <span className="mode mode-fixture">{replayText({ model: r.wonder.model, requestId: r.wonder.requestIds[0], at: "" })}</span>,
    }];
  });
  const policyTimeouts = rec.filter((r) => r.policy && !r.policy.ok);
  if (policyTimeouts.length) {
    wonderNotes.push({
      who: "Fleet policy agent (Muse Wonder 1.0)",
      text: `The fleet's separate policy check on ${policyTimeouts.map((r) => r.short).join(" and ")} returned no answer.`,
      losses: [
        `the policy agent timed out at ${Math.round((policyTimeouts[0].policy!.latencyMs ?? 0) / 1000)} s on ${policyTimeouts.length === rec.length ? "both filmed boxes" : policyTimeouts.map((r) => r.short).join(", ")}; app code stood in and the holds were kept.`,
      ],
    });
  }

  const steps: FlowStep[] = [
    {
      id: "job-track",
      n: "01",
      title: "SAM 3.1 tracks",
      who: "SAM 3.1 · Meta",
      job: "Temporal evidence: a mask and a track ID for each item in every frame, so the counter can see where each item goes and when it stops.",
      limit: "It never counts and never decides.",
      onServer: (
        <>
          <p>The filmed clips d1 and d2 replay their recorded SAM 3.1 run (masks and text only, no footage):</p>
          <span className="mode mode-fixture">{REAL_REPLAY_TEXT}</span>
          <p>Other clips replay a synthetic scene:</p>
          <span className="mode mode-fixture">{MODE_TEXT.RECORDED_FIXTURE}</span>
        </>
      ),
      facts: samFacts,
    },
    {
      id: "job-count",
      n: "02",
      title: "App code counts",
      who: "Tray counter · app code",
      job: "An item counts once, when it settles in the inspected tray. It is built not to add a count for hands, kraft paper, lifted-and-replaced items or re-issued track IDs, and passes the synthetic stress sweep; on the recordings this site replays (my two filmed returns, and gate clips g0 and g1) it counted every item right (g1 with a merged-mask hold). The registered gate is incomplete: g2–g8, the clips that test hands, paper and lifts, were not filmed.",
      limit: "A count is presence in the tray, not identity or condition.",
      onServer: <ModeBadge mode="DETERMINISTIC" />,
      facts: countFacts,
    },
    {
      id: "job-read",
      n: "03",
      title: "Readers read, and can be wrong",
      who: "Spark · auditor · Glimmer",
      job: "Muse Spark 1.3 re-reads the count, crops, slip and policy. The open-weight auditor (Muse Spark Open on Baseten) checks each settled crop for a stand-in or damage. Glimmer (on Modal) transcribes the printed labels. They can disagree with the count and with each other, sometimes wrongly.",
      onServer: (
        <>
          <p>On d1 and d2 each reader&apos;s recorded answer replays:</p>
          <span className="mode mode-fixture">RECORDED LIVE RUN · model · req id</span>
          <p>With no recorded answer, reconcile runs in app code:</p>
          <ModeBadge mode="DETERMINISTIC" />
        </>
      ),
      notes: readerNotes,
    },
    {
      id: "job-hold",
      n: "04",
      title: "A disagreement can hold, never clear",
      who: "Merge · app code",
      job: "App code merges the count and every reader, most restrictive first. A required reader that fails holds the box; optional readers (the auditor, Glimmer, replays) can only add holds, and one that fails adds nothing: the count and the other readers decide.",
      limit: "A reader can turn OK into HELD. No reader can turn HELD into OK.",
      onServer: <ModeBadge mode="DETERMINISTIC" />,
      notes: merged.map((m) => ({
        who: `${m.r.short} · ${m.r.what}`,
        text: m.held.length
          ? <><strong>HELD</strong> ({m.held.join("; ")}).{m.allCounted ? <> All three counted, so this is a <strong>false hold</strong>: the hold came from a reader&apos;s doubt, not the count.</> : " A correct hold: an item on the slip did not settle in the tray."}</>
          : "No hold: every source agreed the kit is complete. It still waits for a person.",
        misreads: misreadsIn(m.r.rma.clipId, m.r.audit?.audit.items.filter((i) => i.standInSuspected).map((i) => i.note).join(" ") ?? "", "camera_body").filter((x) => /toy/.test(x.said)),
        provenance: <ModeBadge mode="DETERMINISTIC" />,
      })),
      boundary: true,
    },
    {
      id: "job-draft",
      n: "05",
      title: "Muse Wonder drafts",
      who: "Muse Wonder 1.0 · Meta",
      job: "A recommendation that cites a clause from the store's policy. A citation that is not in the policy text is rejected.",
      limit: "A draft, not an approval. It cannot move money.",
      onServer: (
        <>
          <p>The draft shown is the app-code template:</p>
          <ModeBadge mode="DETERMINISTIC" />
          <p>or, in a replay of the recorded run on d1 and d2, the recorded Wonder draft:</p>
          <span className="mode mode-fixture">RECORDED LIVE RUN · muse-wonder-1.0 · req id</span>
        </>
      ),
      facts: wonderFacts,
      notes: wonderNotes,
    },
    {
      id: "job-approve",
      n: "06",
      title: "A person approves; Stripe refunds",
      who: "A person · Stripe test mode",
      job: "The reviewer reads the lines, the crops and the cited clause, then approves or keeps the hold. Approval issues a single-use token, bound to that RMA, observation and amount, that expires in 10 minutes. Only that token runs the refund.",
      limit: "A hold is not a denial. A complete kit is not an automatic refund: it waits for this step too.",
      onServer: (
        <>
          <span className="mode mode-det">A PERSON · app-code authorization</span>
          <span className="fixture-label">[Stripe test mode — no real funds moved]</span>
        </>
      ),
      notes: [
        { text: "In this prototype the approver is a typed name; staff sign-in and roles are a production step. The refund endpoint refuses any key that is not a Stripe test key." },
      ],
    },
  ];
  return { steps, d2FalseHold };
}

const STATES = ["Received", "Counted", "Reconciled"];

const PARTS = [
  ["Camera", "Looks straight down at the bench and films the unboxing. It sees; it decides nothing."],
  ["Tray zone", "The marked right-hand side of the mat. An item only counts once it settles here."],
  ["Counter", "App code that watches the tracks and counts an item once when it settles in the tray."],
  ["Readers", "SAM 3.1 finds and outlines items; it does not count. Muse Spark 1.3, the open-weight auditor (Baseten) and Glimmer (Modal) re-read the counts, crops, labels, slip and policy, and can only add a hold."],
  ["Drafter", "Muse Wonder 1.0 writes the recommendation and names the clause it relied on."],
  ["The person", "Approves or keeps the hold. The only one who can let a refund go."],
  ["Refund rail", "Stripe in test mode. It moves test money only after a valid approval."],
];

const STATUS: [string, string, "LIVE" | "FIXTURE" | "RECORDED" | "OFF ON THIS SERVER", string][] = [
  ["Bench station screen", "Pick the RMA, play or record the clip, see stage timers and the per-line result.", "LIVE", "UI. Next.js, React."],
  ["Seeded store, customer, RMA, packing slip, policy", "The merchant data a real store would connect.", "FIXTURE", "Deliberate: no store integration. Labelled [Seeded merchant order & RMA fixture]."],
  ["Item segmentation", "Masks and track IDs per item per frame.", "OFF ON THIS SERVER", "SAM 3.1 has run live on Meta's API in recorded sessions (first on a known-answer synthetic clip, matching the open weights frame for frame). This public server has no Meta key on purpose, so it replays a recorded real run on filmed stand-in props (masks and text only, no footage), labelled RECORDED · replay of a recorded real run, with its losses shown: the complete d2 kit was falsely held. Clips without a recording replay synthetic scenes, labelled RECORDED FIXTURE · synthetic scene."],
  ["Tray-zone counter", "Counts an item when it settles in the tray; ignores hands and paper; flags merged masks and unreadable labels.", "LIVE", "Deterministic, unit-tested on synthetic tracks with the hard cases."],
  ["Reconciliation", "Expected, observed and missing per line, with reasons.", "LIVE", "Schema plus deterministic reconciler."],
  ["Model review of the reconciliation", "Muse Spark 1.3 re-reads the clip, counts, crops, slip and policy in one call and can only add a hold.", "OFF ON THIS SERVER", "Ran live in recorded sessions. No non-Meta fallback. On this public server reconcile runs in app code, labelled DETERMINISTIC; a replay of a real recorded run is labelled RECORDED LIVE RUN with its model and request id."],
  ["Cross-check", "A model answer that disagrees with the counter can only raise a hold.", "LIVE", "Most restrictive result wins."],
  ["Decision draft", "Recommendation and cited clause, validated against the policy text.", "OFF ON THIS SERVER", "Muse Wonder 1.0 ran live in recorded sessions. On this public server the draft is the app-code template, labelled DETERMINISTIC, or, in a replay of the recorded run on d1 and d2, the recorded Wonder draft, labelled RECORDED LIVE RUN with its model and request id."],
  ["State machine + approval token", "Refund needs a single-use, expiring token bound to that RMA and observation; any error is a hold.", "LIVE", "HMAC-SHA256, canonical JSON digest."],
  ["Refund rail", "Seeds a test charge, refunds it on approval, books the $2.00 fee (proposed pricing), shows the re_ id, receipt and webhook payload.", "LIVE", "Stripe test mode only."],
  ["Call log + cost", "Every model call: input, output, latency, cost, model.", "LIVE", "Local call log."],
  ["Gate test harness", "Runs SAM 3.1 on test clips and compares IDs per physical item with the tray counter.", "OFF ON THIS SERVER", "Ran on the filmed bench clips: INCOMPLETE, not run as registered (g2–g8 not filmed); g0 scored correctly, g1 scored correctly (merged_mask hold)."],
  ["Evals", "Counter accuracy on labelled clips; every decision and its human outcome logged.", "RECORDED", "The real gate (INCOMPLETE) and a same-input A/B on 4 filmed clips (Muse Spark alone 4/4, the pipeline 3/4; the pipeline arm ran without the auditor and Glimmer on g0 and g1), next to the synthetic clips."],
];

const statusClass = (s: string) => (s === "LIVE" ? "st st-ok" : s === "FIXTURE" ? "st st-warn" : "st");

export default function HowItWorksPage() {
  const flow = buildFlow();
  return (
    <div className={styles.floor}>
      <section className="container hero" aria-labelledby="hiw-title">
        <div className="stack" style={{ gap: 20 }}>
          <span className="eyebrow">How it works</span>
          <h1 className="h-display" id="hiw-title" style={{ maxWidth: "16ch" }}>Count it. Check it. Hold it. A person decides.</h1>
          <p className="lead">
            A refund that follows a scan pays out for boxes that are not complete. ReturnWitness puts a counted record between the scan and the
            money, so an incomplete {KIT.kitName} ({formatCents(KIT_TOTAL_CENTS)}) is held at the bench and a person approves what goes out.
          </p>
        </div>
      </section>

      <EvidenceFlow
        steps={flow.steps}
        intro={
          <p>
            Each number on a step is measured on my two filmed returns (d1, the lens missing; d2, a complete kit) and says where it
            comes from; a step with nothing measured shows nothing. The props are stand-ins: a real compact film camera for the kit&apos;s
            interchangeable-lens body and a lens-shaped mug for the zoom lens. Every model answer shown is a replay, with its loss lines beside it.
          </p>
        }
        summary={
          flow.d2FalseHold ? (
            <>
              <p>
                <strong>d2, the complete kit: all three counted → HELD: false hold.</strong> The open-weight auditor called the real compact film camera a toy, and
                that one doubt was enough, because any reader may add a hold.
              </p>
              <p>No model can release it. Only a person&apos;s single-use approval can, and nothing refunds until then.</p>
            </>
          ) : undefined
        }
      />

      {/* STATUS */}
      <section id="status" className="container section" aria-labelledby="status-title" style={{ scrollMarginTop: 72 }}>
        <div className="rule-top" style={{ paddingTop: 24 }}>
          <div className="stack" style={{ gap: 24 }}>
            <div className="stack">
              <span className="eyebrow">Status, honestly</span>
              <h2 className="h2" id="status-title">What runs for real here, what runs on recorded data, what runs only where the key is.</h2>
              <p className="lead">
                LIVE runs for real on this server. FIXTURE runs on seeded or recorded data, labelled on screen. OFF ON THIS SERVER works with the Meta
                Model API key, which is kept off this public server on purpose; those steps run live in recorded sessions.
              </p>
            </div>
            <details className={styles.details}>
              <summary>Pipeline modes: what every label means, and the status of each part</summary>
              <div className="stack" style={{ gap: 20, marginTop: 16 }}>
                <div className="row" style={{ gap: 12 }}>
                  <ModeBadge mode="LIVE_META" />
                  <ModeBadge mode="LIVE_OPEN_WEIGHTS" />
                  <ModeBadge mode="RECORDED_FIXTURE" />
                  <span className="mode mode-fixture">{REAL_REPLAY_TEXT}</span>
                  <ModeBadge mode="DETERMINISTIC" />
                </div>
                <p className="muted" style={{ margin: 0, fontSize: 14, maxWidth: "72ch" }}>
                  Every result on screen carries one of these labels. <strong>LIVE · Meta</strong> means a real Meta call produced it.{" "}
                  <strong>LIVE · Meta open weights on a partner GPU</strong> means Meta&apos;s open-weight model ran live on a partner&apos;s GPU (Baseten today), not on Meta&apos;s own API.{" "}
                  <strong>RECORDED FIXTURE · synthetic scene, not a live Meta call</strong> means a saved synthetic result is being replayed;{" "}
                  <strong>RECORDED · replay of a recorded real run, not a live call</strong> means a stage of a real run on filmed clips is being replayed;{" "}
                  <strong>RECORDED LIVE RUN · model · req id</strong> means a saved real model call is being replayed. <strong>DETERMINISTIC · app code, no model</strong>{" "}
                  means plain code produced it.
                </p>
                <div className="table-wrap">
                  <table className="table">
                    <caption className="sr-only">Status of every feature</caption>
                    <thead>
                      <tr>
                        <th scope="col">Feature</th>
                        <th scope="col">What it does</th>
                        <th scope="col">Status</th>
                        <th scope="col">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {STATUS.map(([f, d, s, n]) => (
                        <tr key={f}>
                          <th scope="row" style={{ textAlign: "left", padding: "12px 8px", borderBottom: "1px solid var(--hair)", minWidth: 160 }}>{f}</th>
                          <td style={{ minWidth: 240 }}>{d}</td>
                          <td><span className={statusClass(s)}>{s}</span></td>
                          <td className="muted" style={{ minWidth: 220 }}>{n}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>
          </div>
        </div>
      </section>

      {/* STATE MACHINE */}
      <section className="container section" aria-labelledby="state-title" style={{ paddingTop: 24 }}>
        <div className="cols-2">
          <div className="stack">
            <span className="eyebrow">State machine</span>
            <h2 className="h2" id="state-title">A refund can only move forward through these states.</h2>
            <p className="lead">Anything unresolved, any model disagreement, and any failure of a required step (segmentation, the count, a required reader) lands in Held. An optional reader that fails adds nothing. Held is a stop, not a verdict.</p>
          </div>
          <div className="stack" style={{ gap: 12 }}>
            <ol
              aria-label="Refund states in order"
              style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}
            >
              {STATES.map((s) => (
                <li key={s} style={{ display: "contents" }}>
                  <span className="kbd" style={{ padding: "8px 12px", fontSize: 13 }}>{s}</span>
                  <span aria-hidden className="mono">→</span>
                </li>
              ))}
              <li style={{ display: "contents" }}>
                <span className="kbd" style={{ padding: "8px 12px", fontSize: 13, borderColor: "var(--accent)", color: "var(--danger)" }}>Held</span>
                <span className="mono muted">or</span>
                <span className="kbd" style={{ padding: "8px 12px", fontSize: 13 }}>AwaitingApproval</span>
                <span aria-hidden className="mono">→</span>
                <span className="kbd" style={{ padding: "8px 12px", fontSize: 13 }}>Approved</span>
                <span aria-hidden className="mono">→</span>
                <span className="kbd" style={{ padding: "8px 12px", fontSize: 13 }}>Refunded</span>
              </li>
            </ol>
            <div className="well">
              <strong>A required step that fails = Held.</strong> A failed or malformed answer from a required model, an unreadable serial label. An optional reader that fails or times out adds nothing; it can only ever add a hold.
            </div>
          </div>
        </div>
        <div className="card" style={{ marginTop: 32 }}>
          <span className="eyebrow">The approval token</span>
          <h3 className="h3" style={{ margin: "6px 0 8px" }}>The refund endpoint will not run without one.</h3>
          <div className="cols-3" style={{ marginTop: 8 }}>
            <p style={{ margin: 0 }}><strong>Single use.</strong> Spending it once invalidates it, so one approval cannot trigger two refunds.</p>
            <p style={{ margin: 0 }}><strong>10 minutes.</strong> It expires. A stale approval cannot be replayed later.</p>
            <p style={{ margin: 0 }}><strong>Bound and signed.</strong> HMAC-signed and tied to a digest of that exact RMA, that observation and that amount. Change any of them and it fails.</p>
          </div>
        </div>
      </section>

      <ScaleSection />

      {/* EXPLAINED SIMPLY */}
      <section id="explained-simply" className="container section" aria-labelledby="simply-title" style={{ scrollMarginTop: 72 }}>
        <div className="rule-top" style={{ paddingTop: 24 }}>
          <div className="stack" style={{ gap: 40 }}>
            <div className="stack">
              <span className="eyebrow">Plain English</span>
              <h2 className="h1" id="simply-title">Explained simply</h2>
            </div>

            <div className="cols-2">
              <div className="stack">
                <h3 className="h3">The analogy</h3>
                <div className="prose">
                  <p>
                    Think of a cashier counting items back onto the belt. Each thing that comes out of the bag is put down once, in the clear
                    space, and the cashier ticks it against the receipt. A hand passing over it, or the bag rustling, does not add a tick.
                  </p>
                  <p>
                    If the receipt says three and only two are on the belt, the cashier does not accuse anyone. They hold the money, show what
                    they saw, and ask the manager. That is the whole product: a careful counter with a manager in the loop.
                  </p>
                </div>
              </div>
              <div className="stack">
                <h3 className="h3">The steps</h3>
                <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 8 }}>
                  <li>Pick the RMA on the tablet. The packing slip says what should be in the box.</li>
                  <li>Take items out one at a time and put each in the tray.</li>
                  <li>The camera follows each one; the counter counts it when it settles.</li>
                  <li>The lines show OK, MISSING or HELD against the slip and the policy.</li>
                  <li>A draft names the clause. The person approves or keeps the hold.</li>
                  <li>On approval, the test refund runs and its receipt appears.</li>
                </ol>
              </div>
            </div>

            <div className="stack">
              <h3 className="h3">The parts</h3>
              <div className="table-wrap">
                <table className="table">
                  <caption className="sr-only">The parts of a ReturnWitness bench and what each one does</caption>
                  <thead>
                    <tr><th scope="col">Part</th><th scope="col">What it does</th></tr>
                  </thead>
                  <tbody>
                    {PARTS.map(([a, b]) => (
                      <tr key={a}>
                        <th scope="row" style={{ textAlign: "left", whiteSpace: "nowrap", padding: "12px 8px", borderBottom: "1px solid var(--hair)" }}>{a}</th>
                        <td>{b}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="cols-2">
              <div className="stack">
                <h3 className="h3">What the numbers mean</h3>
                <dl style={{ margin: 0, display: "grid", gap: 12 }}>
                  <div><dt className="mono" style={{ fontWeight: 700 }}>Expected</dt><dd style={{ margin: 0 }}>How many of this line the packing slip says were shipped.</dd></div>
                  <div><dt className="mono" style={{ fontWeight: 700 }}>Seen</dt><dd style={{ margin: 0 }}>How many the counter saw settle in the tray in this clip.</dd></div>
                  <div><dt className="mono" style={{ fontWeight: 700 }}>Missing</dt><dd style={{ margin: 0 }}>Expected minus seen. For RMA-20418 the lens reads 0 of 1, so it is missing.</dd></div>
                  <div><dt className="mono" style={{ fontWeight: 700 }}>Held $</dt><dd style={{ margin: 0 }}>The refund that waits. Here {formatCents(KIT_TOTAL_CENTS)}, the whole kit, until a person decides.</dd></div>
                  <div>
                    <dt className="mono" style={{ fontWeight: 700 }}>Settle time</dt>
                    <dd style={{ margin: 0 }}>The counter waits for an item to stay in the tray for 3 frames at 5 frames per second, which is 0.6 seconds, so a passing item is not counted.</dd>
                  </div>
                </dl>
              </div>
              <div className="stack">
                <h3 className="h3">Who does what</h3>
                <div className="table-wrap">
                  <table className="table">
                    <caption className="sr-only">Who does what in an inspection</caption>
                    <thead><tr><th scope="col">Who</th><th scope="col">Does</th></tr></thead>
                    <tbody>
                      <tr><td><strong>Camera + code</strong></td><td>Count what settles in the tray, and enforce the rules.</td></tr>
                      <tr><td><strong>Meta models</strong></td><td>Read the clip and the paperwork, and draft the recommendation.</td></tr>
                      <tr><td><strong>The person</strong></td><td>{MERCHANT.returnsLead} decides: approve, or keep holding.</td></tr>
                      <tr><td><strong>Stripe</strong></td><td>Moves test money once, after an approval.</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <HeldBoundary />
          </div>
        </div>
      </section>

      <section className="container section" aria-labelledby="hiw-cta">
        <div className="card" style={{ padding: 32 }}>
          <div className="row" style={{ justifyContent: "space-between", gap: 24 }}>
            <div className="stack" style={{ gap: 8, maxWidth: "52ch" }}>
              <h2 className="h2" id="hiw-cta">See the hold happen.</h2>
              <p className="muted" style={{ margin: 0 }}>Two seeded returns: one with the lens missing, one complete. Test mode only.</p>
            </div>
            <div className="row">
              <Link href="/demo" className="btn btn-accent">Run the Instant Demo</Link>
              <Link href="/pricing" className="btn">Pricing</Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
