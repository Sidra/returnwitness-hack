/**
 * The case state machine. Pure: each transition returns a new case with an audit entry.
 *
 *   Received → Counted → Reconciled → Held | AwaitingApproval → Approved → Refunded
 *
 * - An ERROR from any non-terminal state goes to Held (fail-closed). Never to Approved.
 * - Approved is reachable only by a person. Refunded only from Approved, with a refund id.
 * - Refunded is terminal.
 */
import type { Actor, CaseState, ReturnCase } from "@/lib/domain/case";

export type CaseEvent =
  | { type: "COUNTED"; detail: string }
  | { type: "RECONCILED"; detail: string }
  | { type: "HOLD"; reasons: string[]; detail: string }
  | { type: "CLEAR"; detail: string }
  | { type: "APPROVE"; approver: string; detail: string }
  | { type: "REFUNDED"; refundId: string; detail: string }
  | { type: "ERROR"; reason: string; detail: string };

export class IllegalTransition extends Error {
  constructor(
    public readonly from: CaseState,
    public readonly event: CaseEvent["type"],
  ) {
    super(`illegal transition: ${event} from ${from}`);
  }
}

const TABLE: Record<CaseState, Partial<Record<CaseEvent["type"], CaseState>>> = {
  Received: { COUNTED: "Counted", ERROR: "Held" },
  Counted: { RECONCILED: "Reconciled", ERROR: "Held" },
  Reconciled: { HOLD: "Held", CLEAR: "AwaitingApproval", ERROR: "Held" },
  AwaitingApproval: { APPROVE: "Approved", HOLD: "Held", ERROR: "Held" },
  Held: { APPROVE: "Approved", HOLD: "Held", ERROR: "Held" },
  Approved: { REFUNDED: "Refunded", HOLD: "Held", ERROR: "Held" },
  Refunded: {},
};

export const canTransition = (from: CaseState, ev: CaseEvent["type"]): boolean => TABLE[from][ev] !== undefined;

export function transition(c: ReturnCase, ev: CaseEvent, actor: Actor, now = new Date()): ReturnCase {
  const to = TABLE[c.state][ev.type];
  if (!to) throw new IllegalTransition(c.state, ev.type);
  if (ev.type === "APPROVE" && !actor.startsWith("person:")) throw new IllegalTransition(c.state, ev.type);
  if (ev.type === "REFUNDED" && !ev.refundId) throw new IllegalTransition(c.state, ev.type);

  let holdReasons = c.holdReasons;
  if (ev.type === "HOLD") holdReasons = [...new Set([...c.holdReasons, ...ev.reasons])];
  if (ev.type === "ERROR") holdReasons = [...new Set([...c.holdReasons, ev.reason])];

  const at = now.toISOString();
  return {
    ...c,
    state: to,
    holdReasons,
    updatedAt: at,
    audit: [...c.audit, { at, actor, event: ev.type, from: c.state, to, detail: ev.detail }],
  };
}

/** Run `fn`; if it throws, the case goes to Held with the error as the reason. Never rethrows. */
export async function failClosed(c: ReturnCase, stage: string, fn: (c: ReturnCase) => Promise<ReturnCase>): Promise<ReturnCase> {
  try {
    return await fn(c);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (c.state === "Refunded") return c;
    return transition(c, { type: "ERROR", reason: `${stage}_error`, detail: `${stage} failed: ${msg}` }, "system");
  }
}
