/**
 * Reviewer corrections: the learning loop's input. When a person sees a model read a label wrong
 * (or abstain on one they can read), they type the right value. The correction is stored ON the
 * case (append-only, with an audit entry) and later becomes a supervised training row for the
 * label reader (lib/learning/finetune.ts). A correction is training data, never a decision: it
 * does not touch the case's state, reconciliation, approval or refund, so an issued approval
 * token (bound to count + reconciliation) stays valid.
 *
 * The crops the reader saw are NOT persisted on the case (a 1024 px JPEG per item would bloat
 * every stored case and the Redis record). The label reader writes them to a local crop archive
 * instead (`saveCrops`, below), keyed by case id; the dataset builder joins on case id + caption.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ReturnCase, ReviewerCorrection as ReviewerCorrectionRecord } from "@/lib/domain/case";
import type { CaseStore } from "@/lib/store/case-store";
import { VersionConflict } from "@/lib/store/errors";
import { ServiceError } from "@/lib/engine/service";

/** A reviewer types this for a serial/SKU that is genuinely unreadable (teaches the reader to abstain). */
export const UNREADABLE = "unreadable";

export const CorrectionField = z.enum(["serial", "sku", "present", "damage"]);
export type CorrectionField = z.infer<typeof CorrectionField>;

const text = (max: number) => z.string().trim().min(1).max(max);

export const ReviewerCorrection = z.object({
  id: text(64),
  caseId: text(64),
  rmaId: text(64),
  itemKey: text(64),
  field: CorrectionField,
  modelValue: z.string().max(200).nullable(),
  humanValue: text(200),
  reader: text(120),
  cropCaption: z.string().max(400).nullable(),
  person: text(80),
  at: z.string().datetime(),
});
export type ReviewerCorrection = z.infer<typeof ReviewerCorrection>;
// The domain interface and the schema must describe the same record.
const _sameShape: [ReviewerCorrection, ReviewerCorrectionRecord] extends [ReviewerCorrectionRecord, ReviewerCorrection] ? true : never = true;
void _sameShape;

/** What a client sends; the server fills id, caseId, rmaId and at. */
export const CorrectionInput = z.object({
  itemKey: text(64),
  field: CorrectionField,
  modelValue: z.string().max(200).nullable().default(null),
  humanValue: text(200),
  reader: text(120),
  cropCaption: z.string().max(400).nullable().default(null),
  person: text(80),
  /** The case version the reviewer was looking at; a newer stored case is a 409. Omit to append regardless. */
  expectedVersion: z.number().int().nonnegative().optional(),
});
export type CorrectionInput = z.input<typeof CorrectionInput>;

/** Same normalisation reconcile.ts uses for serials: case and punctuation never make a "correction". */
const norm = (field: CorrectionField, v: string | null) => (v == null ? "" : field === "serial" || field === "sku" ? v.replace(/[^a-z0-9]/gi, "").toUpperCase() : v.trim().toLowerCase());

/** Item keys a correction may name: the case's reconciliation lines plus anything the counter counted. */
export function knownItemKeys(c: ReturnCase): Set<string> {
  return new Set([...(c.reconciliation?.lines.map((l) => l.itemKey) ?? []), ...Object.keys(c.count?.counts ?? {})]);
}

export const listCorrections = (c: ReturnCase): ReviewerCorrection[] => c.corrections ?? [];

export async function getCorrections(deps: { store: CaseStore }, caseId: string): Promise<ReviewerCorrection[]> {
  const c = await deps.store.get(caseId);
  if (!c) throw new ServiceError("not_found", `case ${caseId} not found`, 404);
  return listCorrections(c);
}

/**
 * Validate and append one correction through the store's optimistic write. With `expectedVersion`
 * a stale view is a VersionConflict (409); without it, a concurrent write is retried (an append
 * commutes with every other change, so re-reading and re-appending is safe).
 */
export async function recordCorrection(
  deps: { store: CaseStore; now?: () => Date; newId?: () => string },
  caseId: string,
  input: unknown,
): Promise<{ case: ReturnCase; correction: ReviewerCorrection }> {
  const parsed = CorrectionInput.safeParse(input);
  if (!parsed.success) throw new ServiceError("bad_input", `invalid correction: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; ")}`, 400);
  const inp = parsed.data;
  if (norm(inp.field, inp.modelValue) === norm(inp.field, inp.humanValue)) throw new ServiceError("no_change", "the corrected value is the same as the model's read", 400);

  for (let attempt = 0; ; attempt++) {
    const c = await deps.store.get(caseId);
    if (!c) throw new ServiceError("not_found", `case ${caseId} not found`, 404);
    if (inp.expectedVersion !== undefined && inp.expectedVersion !== c.version) throw new VersionConflict(caseId, inp.expectedVersion, c.version);
    const keys = knownItemKeys(c);
    if (!keys.size) throw new ServiceError("incomplete", "the inspection has not counted anything yet; nothing to correct", 409);
    if (!keys.has(inp.itemKey)) throw new ServiceError("unknown_item", `item "${inp.itemKey}" is not on this case (known: ${[...keys].join(", ")})`, 400);

    const at = (deps.now?.() ?? new Date()).toISOString();
    const correction = ReviewerCorrection.parse({
      id: deps.newId?.() ?? `cor_${randomUUID().slice(0, 8)}`,
      caseId: c.id,
      rmaId: c.rmaId,
      itemKey: inp.itemKey,
      field: inp.field,
      modelValue: inp.modelValue,
      humanValue: inp.humanValue,
      reader: inp.reader,
      cropCaption: inp.cropCaption,
      person: inp.person,
      at,
    });
    const next: ReturnCase = {
      ...c,
      updatedAt: at,
      corrections: [...listCorrections(c), correction],
      // Same state in and out: the trail shows who corrected what without implying a transition.
      audit: [...c.audit, { at, actor: `person:${correction.person}`, event: "CORRECTION", from: c.state, to: c.state, detail: `${correction.person} corrected ${correction.reader}'s ${correction.field} read for ${correction.itemKey}: "${correction.modelValue ?? "no read"}" → "${correction.humanValue}" (training data; no effect on the refund)` }],
    };
    try {
      return { case: await deps.store.put(next, c.version), correction };
    } catch (e) {
      if (!(e instanceof VersionConflict) || inp.expectedVersion !== undefined || attempt >= 2) throw e;
    }
  }
}

/* ---------- Crop archive (local; the training images) ---------- */

export interface ArchivedCrop {
  itemKey: string | null;
  caption: string;
  dataUrl: string;
}

const cropDir = () => process.env.RETURNWITNESS_CROPS_DIR || path.join(process.cwd(), ".data", "crops");
const cropFile = (caseId: string) => path.join(cropDir(), `${caseId.replace(/[^a-z0-9_-]/gi, "_")}.json`);

/** Keep the crops a reader saw for this case. Best effort: a read-only filesystem keeps nothing (the dataset then reports the gap). */
export function saveCrops(caseId: string, crops: ArchivedCrop[]): boolean {
  if (!crops.length) return false;
  try {
    fs.mkdirSync(cropDir(), { recursive: true });
    fs.writeFileSync(cropFile(caseId), JSON.stringify({ caseId, savedAt: new Date().toISOString(), crops }));
    return true;
  } catch {
    return false;
  }
}

export function loadCrops(caseId: string): ArchivedCrop[] {
  try {
    const raw = JSON.parse(fs.readFileSync(cropFile(caseId), "utf8")) as { crops?: unknown };
    return z.array(z.object({ itemKey: z.string().nullable(), caption: z.string(), dataUrl: z.string().startsWith("data:image/") })).catch([]).parse(raw.crops);
  } catch {
    return [];
  }
}
