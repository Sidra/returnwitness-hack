/**
 * runWonderAgent against a local chat-completions server: the request ids Meta returns are kept on the run
 * (the trace's LIVE proof shows them), and every billed call lands in the spend log, including the
 * structured fallback used when tool calling is refused.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POLICY, RMAS } from "@/data/fixtures";
import type { Reconciliation } from "@/lib/domain/schemas";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rw-wonder-"));
process.env.RETURNWITNESS_LLM_LOG = path.join(tmp, "llm-calls.jsonl");
process.env.RETURNWITNESS_RECORDINGS_DIR = path.join(tmp, "recordings");

const c43 = POLICY.clauses.find((c) => c.id === "4.3")!;
const DRAFT = { recommendation: "HOLD", proposedRefundCents: 0, citedClauses: [{ clauseId: "4.3", quote: c43.text }], rationale: "A line is missing.", lineNotes: [{ itemKey: "lens", note: "0 of 1 seen" }] };

type Reply = { status?: number; body: unknown };
let script: Reply[] = [];
const seen: Array<Record<string, unknown>> = [];
let server: http.Server;
let base = "";

const completion = (id: string, message: Record<string, unknown>) => ({ id, object: "chat.completion", created: 0, model: "muse-wonder-1.0", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: null, ...message } }], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } });
const toolCall = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push(JSON.parse(raw || "{}"));
      const next = script.shift() ?? { status: 500, body: { error: { message: "script exhausted" } } };
      res.writeHead(next.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(() => server.close());

const recon: Reconciliation = {
  rmaId: RMAS[0].id,
  lines: [{ itemKey: "lens", description: "Zoom lens", expectedQty: 1, observedQty: 0, status: "MISSING", reasons: [{ code: "not_observed", detail: "0 of 1 seen" }], unitPriceCents: 9900 }],
  summary: { allClear: false },
} as unknown as Reconciliation;

async function run() {
  const { runWonderAgent } = await import("@/lib/meta/wonder-agent");
  const { metaConfig } = await import("@/lib/meta/config");
  const cfg = metaConfig({ META_HACK_API_KEY: "test-key", META_BASE_URL: base } as unknown as NodeJS.ProcessEnv);
  return runWonderAgent({ clipId: "wonder-test", caseId: "case_test", state: "Held", digest: "abc123", rma: RMAS[0], policy: POLICY, recon }, cfg);
}
const logRows = () => (fs.existsSync(process.env.RETURNWITNESS_LLM_LOG!) ? fs.readFileSync(process.env.RETURNWITNESS_LLM_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

describe("Muse Wonder live run: request ids and spend log", () => {
  it("every Wonder request carries the agent's stable prompt_cache_key", async () => {
    script = [
      { body: completion("chatcmpl-k1", { tool_calls: [toolCall("k1", "read_reconciliation", {})] }) },
      { body: completion("chatcmpl-k2", { tool_calls: [toolCall("k2", "propose_transition", { to_state: "HELD", evidence_digest: "abc123", reason: "lens missing" })] }) },
      { body: completion("chatcmpl-k3", { content: JSON.stringify(DRAFT) }) },
    ];
    const from = seen.length;
    await run();
    const sent = seen.slice(from);
    expect(sent.length).toBeGreaterThan(0);
    for (const b of sent) expect(b.prompt_cache_key).toBe("returnwitness:decision-agent");
  });

  it("tools path: keeps every completion id in order and logs one row with all tokens", async () => {
    script = [
      { body: completion("chatcmpl-1", { tool_calls: [toolCall("t1", "read_reconciliation", {})] }) },
      { body: completion("chatcmpl-2", { tool_calls: [toolCall("t2", "propose_transition", { to_state: "HELD", evidence_digest: "abc123", reason: "lens missing" })] }) },
      { body: completion("chatcmpl-3", { content: JSON.stringify(DRAFT) }) },
    ];
    const before = logRows().length;
    const r = await run();
    expect(r.protocol).toBe("tools");
    expect(r.requestIds).toEqual(["chatcmpl-1", "chatcmpl-2", "chatcmpl-3"]);
    expect(r.draft).toMatchObject({ recommendation: "HOLD" });
    const rows = logRows().slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "meta", purpose: "decision_agent", ok: true, inputTokens: 3000, outputTokens: 300 });
    expect(rows[0].costUsd).toBeGreaterThan(0);
    // The tool result handed to the model carries the clauses structured.
    const toolMsg = (seen[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool")!;
    expect(JSON.parse(toolMsg.content).policy[0]).toEqual({ clauseId: POLICY.clauses[0].id, title: POLICY.clauses[0].title, text: POLICY.clauses[0].text });
  });

  it("structured fallback (tools refused): both billed calls are logged, ids kept, strict schemas sent", async () => {
    script = [
      { status: 400, body: { error: { message: "tool calling is not supported for this model" } } },
      { body: completion("chatcmpl-s1", { content: JSON.stringify({ to_state: "HELD", evidence_digest: "abc123", reason: "lens missing" }) }) },
      { body: completion("chatcmpl-s2", { content: JSON.stringify({ ...DRAFT, citedVoiceNote: null }) }) },
    ];
    seen.length = 0;
    const before = logRows().length;
    const r = await run();
    expect(r.protocol).toBe("structured");
    expect(r.requestIds).toEqual(["chatcmpl-s1", "chatcmpl-s2"]);
    // citedVoiceNote:null (strict mode's "not given") is dropped, so the draft parses.
    expect(r.draft).toMatchObject({ recommendation: "HOLD" });
    expect((r.draft as Record<string, unknown>).citedVoiceNote).toBeUndefined();
    const rows = logRows().slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: "decision_agent", ok: true, inputTokens: 2000, outputTokens: 200 });
    const fmt = (seen[2].response_format as { json_schema: { schema: { additionalProperties: boolean; required: string[] } } }).json_schema.schema;
    expect(fmt.additionalProperties).toBe(false);
    expect(fmt.required).toContain("citedVoiceNote");
  });

  it("a failed structured call is still logged, as not ok", async () => {
    script = [
      { status: 400, body: { error: { message: "tool calling is not supported for this model" } } },
      { status: 500, body: { error: { message: "upstream down" } } },
      { status: 500, body: { error: { message: "upstream down" } } },
    ];
    const before = logRows().length;
    const r = await run();
    expect(r.error).toBeTruthy();
    const rows = logRows().slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
  });
});
