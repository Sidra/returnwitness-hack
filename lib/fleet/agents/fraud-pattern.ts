/**
 * Fraud-pattern agent: looks ACROSS the shift's returns, which no per-return agent can do.
 *   - repeat address: three or more returns from one shipping address (name spellings vary) are
 *     each held for a person, including the ones that look complete on their own;
 *   - duplicate serial: the same serial read in two boxes means one of them carries a copied label,
 *     so the serialised line is held on every return it appears in, even the one whose serial
 *     matches its own order.
 * It holds; it never accuses: the reason says what pattern was seen. App code, runs once per shift.
 */
import type { ShiftReturn } from "@/data/shift";
import type { FraudFlag, FraudOutput, InspectorOutput, LabelReaderOutput } from "../context";
import type { AgentResult, AgentSpec, HoldEffect } from "../types";
import { normSerial } from "./serial-matcher";

export const REPEAT_ADDRESS_MIN = 3;

export const fraudPatternSpec: AgentSpec = {
  name: "fraud-pattern-agent",
  role: "fraud-pattern-agent",
  kind: "code",
  costPerRunUsd: 0,
  costBasis: "app code",
  scope: "shift",
  does: "finds patterns across the shift's returns: repeat addresses, the same serial in two boxes",
};

export const normAddress = (a: string) =>
  a
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\broad\b/g, "rd")
    .replace(/\s+/g, " ")
    .trim();

export interface FraudInput {
  ret: ShiftReturn;
  inspector?: InspectorOutput;
  labelReader?: LabelReaderOutput;
}

export function runFraudPattern(inputs: FraudInput[]): Map<string, AgentResult<FraudOutput>> {
  const flags = new Map<string, FraudFlag[]>(inputs.map((i) => [i.ret.rma.id, []]));

  const byAddress = new Map<string, FraudInput[]>();
  for (const i of inputs) byAddress.set(normAddress(i.ret.order.address), [...(byAddress.get(normAddress(i.ret.order.address)) ?? []), i]);
  for (const group of byAddress.values()) {
    if (group.length < REPEAT_ADDRESS_MIN) continue;
    const ids = group.map((g) => g.ret.rma.id);
    const names = [...new Set(group.map((g) => g.ret.order.customer.name))];
    for (const g of group) {
      flags.get(g.ret.rma.id)!.push({
        kind: "repeat_address",
        itemKey: "*",
        related: ids.filter((x) => x !== g.ret.rma.id),
        detail: `${group.length} returns from one address in this shift (${ids.join(", ")}) under ${names.length} name spelling${names.length > 1 ? "s" : ""}`,
      });
    }
  }

  const bySerial = new Map<string, Array<{ rmaId: string; itemKey: string; text: string }>>();
  for (const i of inputs) {
    if (!i.inspector) continue;
    for (const a of i.inspector.count.arrivals) {
      if (!a.label) continue;
      const lr = i.labelReader?.reads.find((r) => r.itemKey === a.itemKey);
      if (lr && !lr.legible) continue; // an illegible read is no evidence of a copy
      const k = normSerial(a.label.text);
      const list = bySerial.get(k) ?? [];
      if (!list.some((x) => x.rmaId === i.ret.rma.id)) list.push({ rmaId: i.ret.rma.id, itemKey: a.itemKey, text: a.label.text });
      bySerial.set(k, list);
    }
  }
  const recordConflicts = new Map<string, string[]>();
  for (const [serial, list] of bySerial) {
    if (list.length < 2) continue;
    // Every box's own order record lists this serial: the merchant's records conflict (a unit recorded on two
    // orders), which is an inventory question, not evidence about the customer's box. Work item, no hold.
    const listedOnAll = list.every((x) => inputs.find((i) => i.ret.rma.id === x.rmaId)!.ret.order.slip.lines.some((l) => l.serial && normSerial(l.serial) === serial));
    if (listedOnAll) {
      for (const x of list) recordConflicts.set(x.rmaId, [...(recordConflicts.get(x.rmaId) ?? []), `serial "${x.text}" is on the order records of ${list.map((y) => y.rmaId).join(" and ")}: check the serial record (inventory)`]);
      continue;
    }
    for (const x of list) {
      flags.get(x.rmaId)!.push({
        kind: "duplicate_serial",
        itemKey: x.itemKey,
        related: list.filter((y) => y.rmaId !== x.rmaId).map((y) => y.rmaId),
        detail: `serial "${x.text}" was read in ${list.length} boxes this shift (${list.map((y) => y.rmaId).join(", ")}); one label is a copy`,
      });
    }
  }

  const out = new Map<string, AgentResult<FraudOutput>>();
  for (const i of inputs) {
    const f = flags.get(i.ret.rma.id)!;
    const conflicts = recordConflicts.get(i.ret.rma.id) ?? [];
    const holds: HoldEffect[] = f.map((x) => ({ itemKey: x.itemKey, code: x.kind, detail: `fraud-pattern agent: ${x.detail}` }));
    out.set(i.ret.rma.id, {
      output: { flags: f },
      trace: f.length ? f.map((x) => (x.kind === "repeat_address" ? `repeat address with ${x.related.join(", ")}` : `serial also read on ${x.related.join(", ")}`)).join("; ") : conflicts.length ? `no pattern against a box; ${conflicts.length} order-record conflict(s) sent to inventory` : `no pattern across the ${inputs.length} returns`,
      holds,
      workItems: [
        ...(f.length ? [{ by: fraudPatternSpec.name, text: `Review together with ${[...new Set(f.flatMap((x) => x.related))].join(", ")}` }] : []),
        ...conflicts.map((text) => ({ by: fraudPatternSpec.name, text: text.charAt(0).toUpperCase() + text.slice(1) })),
      ],
    });
  }
  return out;
}
