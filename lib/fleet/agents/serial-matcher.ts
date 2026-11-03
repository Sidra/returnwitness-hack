/**
 * Serial matcher: does the serial in the box match the order record? Uses the label reader's
 * judgement when it ran (an illegible read is left to the label reader's hold, not called a
 * mismatch); without it, matches on the counter's raw reads. A mismatch holds the line, and a
 * serial that belongs to another order in this shift is named. App code.
 */
import type { ItemKey, ShiftReturn } from "@/data/shift";
import type { ReturnCtx, SerialCheck, SerialMatcherOutput } from "../context";
import { LEGIBLE_MIN_CONFIDENCE } from "./label-reader";
import type { AgentResult, AgentSpec, HoldEffect } from "../types";

export const normSerial = (s: string) => s.replace(/[^a-z0-9]/gi, "").toUpperCase();

export const serialMatcherSpec: AgentSpec = {
  name: "serial-matcher",
  role: "serial-matcher",
  kind: "code",
  costPerRunUsd: 0,
  costBasis: "app code",
  scope: "return",
  does: "matches each serial read against the order record and names the order a stray serial belongs to",
};

export function runSerialMatcher(ctx: ReturnCtx & { shiftReturns: ShiftReturn[] }): AgentResult<SerialMatcherOutput> {
  const insp = ctx.up.inspector;
  if (!insp) return { output: { checks: [] }, trace: "no count from the inspector: no serial reads to match", holds: [], workItems: [] };
  const checks: SerialCheck[] = [];
  const holds: HoldEffect[] = [];
  for (const line of ctx.ret.order.slip.lines) {
    if (!line.requiresSerial || !line.serial) continue;
    const key = line.itemKey as ItemKey;
    if (!insp.count.arrivals.some((a) => a.itemKey === key)) continue;
    // Reads worth matching: the label reader's legible read, and the counter's own read when it is confident
    // (≥ 0.80). Without a label reader, the counter's raw read. A mismatch on ANY of them holds the line; an
    // uncertain read alone is left to the label reader's hold (calling a smudge a swap would be wrong).
    const raw = insp.count.arrivals.find((a) => a.itemKey === key && a.label)?.label;
    const candidates: string[] = [];
    if (ctx.up.labelReader) {
      const lr = ctx.up.labelReader.reads.find((r) => r.itemKey === key);
      if (lr?.legible && lr.text) candidates.push(lr.text);
      if (raw && raw.confidence >= LEGIBLE_MIN_CONFIDENCE) candidates.push(raw.text);
    } else if (raw) {
      candidates.push(raw.text);
    }
    if (!candidates.length) {
      checks.push({ itemKey: key, expected: line.serial, read: ctx.up.labelReader?.reads.find((r) => r.itemKey === key)?.text ?? raw?.text ?? null, match: null });
      continue;
    }
    const read = candidates.find((c) => normSerial(c) !== normSerial(line.serial!)) ?? candidates[0];
    const match = normSerial(read) === normSerial(line.serial);
    const check: SerialCheck = { itemKey: key, expected: line.serial, read, match };
    if (!match) {
      const other = ctx.shiftReturns.find((r) => r.rma.id !== ctx.ret.rma.id && r.order.slip.lines.some((l) => l.serial && normSerial(l.serial) === normSerial(read!)));
      if (other) check.belongsTo = { orderId: other.order.id, rmaId: other.rma.id };
      holds.push({
        itemKey: key,
        code: "serial_mismatch",
        detail: `serial matcher: label reads "${read}", the order record says "${line.serial}"${other ? `; "${read}" was sold on ${other.order.id} (${other.rma.id})` : ""} (clause 4.4)`,
      });
    }
    checks.push(check);
  }
  const bad = checks.filter((c) => c.match === false);
  return {
    output: { checks },
    trace: checks.length === 0 ? "no serialised item reached the tray" : bad.length ? `mismatch on ${bad.map((b) => `${b.itemKey} (${b.read} ≠ ${b.expected})`).join(", ")}` : `${checks.filter((c) => c.match).length} serial(s) match the order record${checks.some((c) => c.match === null) ? "; illegible reads left to the label reader" : ""}`,
    holds,
    workItems: bad.map((b) => ({ by: serialMatcherSpec.name, text: `Photograph the ${b.itemKey.replace("_", " ")} serial for the swap record` })),
  };
}
