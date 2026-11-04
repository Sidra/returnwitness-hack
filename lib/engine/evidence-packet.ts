/**
 * Dispute & carrier-claim evidence packet: one held (or settled) case, exported as a signed JSON bundle a merchant
 * can attach when a customer disputes the charge or when a transit claim is filed. Pure app code over the stored
 * ReturnCase; nothing is recomputed and no model is called.
 *
 * What it contains: the order and packing slip, what the tray counter saw (arrivals with time, frame and box), the
 * reconciliation per line with reasons, the policy clauses the decision rests on (verbatim), the draft and the agent
 * trace with their request ids, the independent readers, the voice note, the person's approval and the test refund,
 * and the audit trail, each with its mode label. Provenance is carried, never upgraded: a replayed synthetic scene
 * stays "RECORDED FIXTURE · synthetic scene"; a replay of a recorded real run says "replay of a recorded real run". The packet also says what a hold does NOT show.
 *
 * Signing: Ed25519 over the canonical JSON of everything but the signature, so anyone holding the public key
 * (GET /api/packet-key) can check that no field changed. The key is derived from the approval secret
 * (HMAC → 32-byte seed), so no new secret is needed and the public key is stable per deployment. No secret → the
 * packet is still produced, with `signature: null` and an "unsigned" limitation, never a fake signature.
 */
import { createHmac, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import type { ReturnCase } from "@/lib/domain/case";
import { MODE_TEXT, type PackingSlip, type Policy, type Rma } from "@/lib/domain/schemas";
import { canonicalJson, sha256 } from "./digest";
import { fromFilmedClip, isRealReplay, modeText } from "@/lib/domain/schemas";
import { misreadsFor } from "@/data/known-misreads";
import { neutralizeTimes } from "@/lib/public/neutral-times";

export const PACKET_SCHEMA = "returnwitness.evidence-packet/1";
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface PacketSignature {
  alg: "Ed25519";
  keyId: string;
  publicKeyPem: string;
  /** base64 Ed25519 signature over `contentSha256`'s input: canonicalJson(packet without `signature`). */
  value: string;
}

export interface EvidencePacket {
  schema: typeof PACKET_SCHEMA;
  generatedAt: string;
  purpose: string;
  case: { id: string; runId: string; rmaId: string; orderId: string; state: string; holdReasons: string[]; createdAt: string; updatedAt: string };
  order: { orderId: string; shippedAt: string; customerName: string; requestedRefundCents: number; customerReason: string; returnOpenedAt: string; lines: PackingSlip["lines"] };
  observation: {
    clip: { clipId: string; source: string; label: string; provenance: string; durationS: number; fps: number; requestIds: string[] };
    arrivals: Array<{ itemKey: string; t: number; frameIndex: number; bbox: number[]; label: string | null }>;
    flags: Array<{ code: string; itemKeys: string[]; t: number; detail: string }>;
  };
  reconciliation: { label: string; lines: Array<{ itemKey: string; description: string; expected: number; observed: number; status: string; unitPriceCents: number; reasons: string[] }>; policyHolds: string[] } | null;
  policy: { id: string; version: string; clauses: Array<{ id: string; title: string; text: string }> };
  draft: { source: string; label: string; model: string | null; recommendation: string; proposedRefundCents: number; rationale: string; citedClauseIds: string[]; rejected: string[] } | null;
  agent: { model: string; label: string; protocol: string; effect: string; requestIds: string[]; steps: string[] } | null;
  readers: Array<{ reader: string; model: string; label: string; ok: boolean; requestId: string | null; error: string | null }>;
  voiceNote: { transcript: string; label: string; provenance: string; requestId: string | null } | null;
  approval: { approver: string; approverIdentity: string; amountCents: number; override: boolean; note: string; evidenceDigest: string; issuedAt: string } | null;
  refund: { refundId: string; status: string; amountCents: number; chargeId: string; livemode: false; createdAt: string; label: string } | null;
  timeline: Array<{ at: string; actor: string; event: string; to: string; detail: string }>;
  limitations: string[];
  contentSha256: string;
  signature: PacketSignature | null;
}

export interface PacketContext {
  rma: Rma;
  slip: PackingSlip;
  policy: Policy;
}

/* ---------- Keys ---------- */

export interface PacketKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyPem: string;
  keyId: string;
}

/** Deterministic Ed25519 key pair from the approval secret. Null when there is no usable secret. */
export function packetKeys(secret: string | undefined): PacketKeys | null {
  if (!secret || secret.length < 32) return null;
  const seed = createHmac("sha256", secret).update("returnwitness/evidence-packet/v1").digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKey, publicKey, publicKeyPem, keyId: sha256(publicKeyPem).slice(0, 16) };
}

/* ---------- Build ---------- */

const label = (m: keyof typeof MODE_TEXT) => MODE_TEXT[m];

/** The clauses the decision rests on: those the draft cites, plus the kit, serial and hold clauses the engine applies. */
function relevantClauses(c: ReturnCase, policy: Policy) {
  const ids = new Set<string>(["4.2", "4.3", "5.1"]);
  for (const q of c.draft?.draft.citedClauses ?? []) ids.add(q.clauseId);
  if (c.reconciliation?.lines.some((l) => l.reasons.some((r) => r.code === "serial_mismatch"))) ids.add("4.4");
  for (const h of c.reconciliation?.policyHolds ?? []) ids.add(h.clauseId);
  return policy.clauses.filter((x) => ids.has(x.id)).map((x) => ({ id: x.id, title: x.title, text: x.text }));
}

export function buildPacket(c: ReturnCase, ctx: PacketContext, opts: { now?: Date; keys?: PacketKeys | null; neutralTimes?: boolean } = {}): EvidencePacket {
  const now = opts.now ?? new Date();
  const keys = opts.keys ?? null;
  const replay = c.clip.mode === "RECORDED_FIXTURE";
  const realReplay = replay && isRealReplay(c.clip.provenance);
  const misreads = fromFilmedClip(c.clip) ? misreadsFor(c.clip.clipId) : [];
  // A replay of a recorded real run says so on every label, never "synthetic scene".
  const tag = (m: keyof typeof MODE_TEXT) => modeText(m, realReplay);
  const limitations = [
    "A hold records that the camera did not see an item settle in the tray during this clip, or saw something it could not resolve. It is a question for a person, not proof the customer kept anything, and not proof an item it did see is genuine or undamaged.",
    "Structured to map onto common dispute and carrier-claim fields; it is not certified for any card-network evidence programme or a carrier's claim form.",
    ...(replay && !realReplay ? ["The observation in this packet is a replayed synthetic scene (RECORDED FIXTURE), not footage of a real box."] : []),
    ...(realReplay ? ["The observation in this packet is a replay of a recorded real run (real footage, recorded model answers), not a live inspection."] : []),
    ...misreads.map((m) => `Known misread (a loss): ${m.by.join(", ")} said "${m.said}" (${m.itemKey}); ${m.loss}.`),
    ...(c.approval ? ["The approver is a typed name in this prototype; staff sign-in and roles are a production step."] : []),
    ...(c.refund ? ["The refund ran in Stripe test mode; no real funds moved."] : []),
    ...(keys ? [] : ["Unsigned: this server has no signing key, so only the content hash is given."]),
  ];
  const body: Omit<EvidencePacket, "contentSha256" | "signature"> = {
    schema: PACKET_SCHEMA,
    generatedAt: now.toISOString(),
    purpose: "Evidence for a returns dispute or a carrier claim: what was expected, what the bench recorded, why the refund was held or released, and who decided.",
    case: { id: c.id, runId: c.runId, rmaId: c.rmaId, orderId: c.orderId, state: c.state, holdReasons: c.holdReasons, createdAt: c.createdAt, updatedAt: c.updatedAt },
    order: {
      orderId: ctx.slip.orderId,
      shippedAt: ctx.slip.shippedAt,
      customerName: ctx.rma.customer.name,
      requestedRefundCents: ctx.rma.requestedRefundCents,
      customerReason: ctx.rma.reason,
      returnOpenedAt: ctx.rma.createdAt,
      lines: ctx.slip.lines,
    },
    observation: {
      clip: { clipId: c.clip.clipId, source: c.clip.source, label: tag(c.clip.mode), provenance: c.clip.provenance, durationS: c.clip.durationS, fps: c.clip.fps, requestIds: c.clip.requestIds ?? [] },
      arrivals: (c.count?.arrivals ?? []).map((a) => ({ itemKey: a.itemKey, t: a.t, frameIndex: a.frameIndex, bbox: [...a.bbox], label: a.label?.text ?? null })),
      flags: (c.count?.flags ?? []).map((f) => ({ code: f.code, itemKeys: f.itemKeys, t: f.t, detail: f.detail })),
    },
    reconciliation: c.reconciliation
      ? {
          label: tag(c.reconciliation.mode),
          lines: c.reconciliation.lines.map((l) => ({ itemKey: l.itemKey, description: l.description, expected: l.expectedQty, observed: l.observedQty, status: l.status, unitPriceCents: l.unitPriceCents, reasons: l.reasons.map((r) => `${r.code}: ${r.detail}`) })),
          policyHolds: (c.reconciliation.policyHolds ?? []).map((h) => `clause ${h.clauseId}: ${h.detail}`),
        }
      : null,
    policy: { id: ctx.policy.id, version: ctx.policy.version, clauses: relevantClauses(c, ctx.policy) },
    draft: c.draft
      ? {
          source: c.draft.source,
          label: tag(c.draft.mode),
          model: c.draft.model ?? null,
          recommendation: c.draft.draft.recommendation,
          proposedRefundCents: c.draft.draft.proposedRefundCents,
          rationale: c.draft.draft.rationale,
          citedClauseIds: c.draft.draft.citedClauses.map((q) => q.clauseId),
          rejected: c.draft.rejected?.errors ?? [],
        }
      : null,
    agent: c.draft?.agent
      ? {
          model: c.draft.agent.model,
          label: tag(c.draft.agent.mode),
          protocol: c.draft.agent.protocol,
          effect: c.draft.agent.effect,
          requestIds: c.draft.agent.requestIds ?? [],
          steps: c.draft.agent.steps.map((s) => [s.kind, s.name, s.verdict ? (s.verdict.accepted ? "accepted" : `rejected: ${s.verdict.reason}`) : null].filter(Boolean).join(" · ")),
        }
      : null,
    readers: (c.readerRuns ?? []).map((r) => ({ reader: r.reader, model: r.model, label: r.ok ? tag(r.mode) : "NOT RUN", ok: r.ok, requestId: r.requestId ?? null, error: r.error ?? null })),
    voiceNote: c.voiceNote ? { transcript: c.voiceNote.transcript, label: tag(c.voiceNote.mode), provenance: c.voiceNote.provenance, requestId: c.voiceNote.requestId ?? null } : null,
    approval: c.approval
      ? { approver: c.approval.approver, approverIdentity: "typed name (unverified in this prototype)", amountCents: c.approval.amountCents, override: c.approval.override, note: c.approval.note, evidenceDigest: c.approval.digest, issuedAt: c.approval.issuedAt }
      : null,
    refund: c.refund ? { refundId: c.refund.refundId, status: c.refund.status, amountCents: c.refund.amountCents, chargeId: c.refund.chargeId, livemode: false, createdAt: c.refund.createdAt, label: "Stripe test mode, no real funds moved" } : null,
    timeline: c.audit.map((a) => ({ at: a.at, actor: a.actor, event: a.event, to: a.to, detail: a.detail })),
    limitations,
  };
  // On the public site the packet carries neutral times (no run dates), and the hash and signature cover exactly that.
  const signed = opts.neutralTimes ? neutralizeTimes(body, now.getTime()) : body;
  const content = canonicalJson(signed);
  const contentSha256 = sha256(content);
  const signature: PacketSignature | null = keys ? { alg: "Ed25519", keyId: keys.keyId, publicKeyPem: keys.publicKeyPem, value: edSign(null, Buffer.from(content), keys.privateKey).toString("base64") } : null;
  return { ...signed, contentSha256, signature };
}

/* ---------- Verify ---------- */

export type PacketVerdict = { ok: true; keyId: string } | { ok: false; reason: string };

/**
 * Checks a packet as received: the content hash matches the content, and the Ed25519 signature verifies under the
 * expected public key (pass the deployment's key; without one, the key embedded in the packet is used and the
 * verdict only proves internal consistency, which the caller should say).
 */
export function verifyPacket(p: unknown, expectedPublicKeyPem?: string): PacketVerdict {
  if (!p || typeof p !== "object") return { ok: false, reason: "not a JSON object" };
  const packet = p as Partial<EvidencePacket>;
  if (packet.schema !== PACKET_SCHEMA) return { ok: false, reason: `unknown schema ${String(packet.schema)}` };
  const { contentSha256, signature, ...body } = packet;
  const content = canonicalJson(body);
  if (sha256(content) !== contentSha256) return { ok: false, reason: "content hash does not match: a field was changed" };
  if (!signature) return { ok: false, reason: "unsigned packet: only the content hash could be checked" };
  if (expectedPublicKeyPem && signature.publicKeyPem.trim() !== expectedPublicKeyPem.trim()) return { ok: false, reason: "signed with a different key than this deployment's" };
  try {
    const ok = edVerify(null, Buffer.from(content), createPublicKey(signature.publicKeyPem), Buffer.from(signature.value, "base64"));
    return ok ? { ok: true, keyId: signature.keyId } : { ok: false, reason: "signature does not verify" };
  } catch (e) {
    return { ok: false, reason: `signature unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
}
