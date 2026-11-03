// MOCK of the Meta Model API for a local contract test of the live wiring. Never used by the app.
// SAM answers in Meta's documented token stream (lib/meta/sam-tokens.ts): streamed output_text, one line per
// frame, a box token in source pixels of the uploaded clip, then a mask (the docs' sample raster, which the
// adapter scales to the box).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.MOCK_META_PORT ?? 3799);
const calls = [];
// One item per concept, settled at a fixed tray spot from frame 4 to the clip's last frame (normalised xyxy).
const SPOTS = {
  "mint green object": [0.64, 0.26, 0.72, 0.34],
  "camera lens": [0.82, 0.27, 0.9, 0.38],
  "battery": [0.73, 0.66, 0.79, 0.73],
};

// Frame 0's first mask exactly as Meta's docs print it (https://dev.meta.ai/docs/sam/reading-segmentation).
const MASK = "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>";
// Source frame size of the last uploaded clip (the adapter normalises SAM boxes by the clip's own size).
let frameSize = { w: 1280, h: 720, frames: 15 };
function probeUpload(bytes) {
  // The SDK posts multipart/form-data; the mp4 is the part's body. ffprobe reads it from a temp file.
  const f = path.join(os.tmpdir(), `rw-mock-upload-${process.pid}.bin`);
  try {
    const start = bytes.indexOf("ftyp") - 4; // the mp4's first box, inside the multipart part
    const end = bytes.lastIndexOf("\r\n--");
    fs.writeFileSync(f, start >= 0 ? bytes.subarray(start, end > start ? end : bytes.length) : bytes);
    const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames", "-of", "csv=p=0", f], { encoding: "utf8" });
    const [w, h, n] = out.trim().split(",").map(Number);
    return w > 0 && h > 0 ? { w, h, frames: n > 0 ? n : frameSize.frames } : frameSize;
  } catch {
    return frameSize;
  } finally {
    fs.rmSync(f, { force: true });
  }
}

const send = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

http
  .createServer(async (req, res) => {
    const body = await readBody(req);
    calls.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== "Bearer mock-key") return send(res, 401, { error: { message: "bad key" } });
    if (req.url === "/v1/files" && req.method === "POST") {
      frameSize = probeUpload(body);
      return send(res, 200, { id: "file_mock_1", object: "file", bytes: body.length });
    }
    if (req.url === "/v1/responses" && req.method === "POST") {
      const j = JSON.parse(body.toString());
      const concept = j.input[0].content.find((c) => c.type === "input_text").text;
      const box = SPOTS[concept];
      const { w, h, frames } = frameSize;
      const tok = box && `<|box;x1=${Math.round(box[0] * w)};y1=${Math.round(box[1] * h)};x2=${Math.round(box[2] * w)};y2=${Math.round(box[3] * h)};w=${w};h=${h};c=0.93|>${MASK}`;
      const text = box ? Array.from({ length: Math.max(0, frames - 4) }, (_, i) => `<${i + 4}f>7${tok}\n`).join("") : ""; // empty = "no matches"
      const id = `resp_${concept.replace(/\W/g, "")}`;
      if (!j.stream) return send(res, 200, { id, output: [{ type: "message", content: [{ type: "output_text", text }] }] });
      const lane = { item_id: "message-0", output_index: 0, content_index: 0 };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      ev({ type: "response.created", response: { id } });
      if (text) ev({ type: "response.output_text.delta", ...lane, delta: text });
      ev({ type: "response.output_text.done", ...lane, text });
      ev({ type: "response.completed", response: { id, status: "completed" } });
      return res.end();
    }
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      const j = JSON.parse(body.toString());
      if (j.tools) {
        // Agent loop: read → try APPROVED (the guard must reject it) → propose the allowed move → draft.
        const toolMsgs = j.messages.filter((m) => m.role === "tool");
        const last = toolMsgs.at(-1);
        const reply = (message) => send(res, 200, { id: "chat_agent", choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 800, completion_tokens: 120 } });
        const call = (name, args) => reply({ role: "assistant", content: null, tool_calls: [{ id: `call_${toolMsgs.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
        calls.push(`  agent turn ${toolMsgs.length}`);
        if (!last) return call("read_reconciliation", {});
        const view = JSON.parse(j.messages.find((m) => m.role === "tool").content);
        if (toolMsgs.length === 1) return call("propose_transition", { to_state: "APPROVED", evidence_digest: view.evidence_digest, reason: "mock: tries to approve" });
        if (toolMsgs.length === 2) return call("propose_transition", { to_state: view.allClear ? "AWAITING_APPROVAL" : "HELD", evidence_digest: view.evidence_digest, reason: "mock: allowed move" });
        return reply({ role: "assistant", content: JSON.stringify({ recommendation: view.allClear ? "APPROVE_FULL" : "HOLD", proposedRefundCents: view.allClear ? 34000 : 23100, citedClauses: [{ clauseId: "4.2", quote: "A kit is refunded in full only when every component listed on the packing slip is returned." }], rationale: "mock agent draft", lineNotes: [] }) });
      }
      if (j.response_format?.type === "json_object" && /audit/i.test(j.messages[0].content)) {
        // Open-weight audit, one crop per request: flags visible damage on the charger so the contract test sees a
        // raised hold, and answers the lens's first request with a schema echo (what Baseten's model did on g1) so
        // the corrective retry runs.
        const userText = j.messages.find((m) => m.role === "user").content.find((c) => c.type === "text").text;
        const itemKey = /Item key: (\w+)/.exec(userText)?.[1] ?? "?";
        const retry = j.messages.some((m) => m.role === "assistant");
        const answer =
          itemKey === "lens" && !retry
            ? { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { itemKey: { type: "string" } } }
            : { itemKey, labelLegible: true, visibleDamage: itemKey === "battery", standInSuspected: false, note: itemKey === "battery" ? "mock: cracked charger casing" : "mock: label reads clearly" };
        calls.push(`  open-weight audit ${itemKey}${retry ? " (retry)" : ""} (${j.model})`);
        return send(res, 200, { id: "chat_audit", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(answer) }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 90 } });
      }
      const name = j.response_format?.json_schema?.name;
      const content =
        name === "reconciliation"
          ? {
              lines: [
                { itemKey: "camera_body", observedQty: 1, status: "OK", reasons: [], serialRead: "BW-CB-55120" },
                { itemKey: "lens", observedQty: 1, status: "OK", reasons: [], serialRead: "BW-LN-80311" },
                { itemKey: "battery", observedQty: 1, status: "OK", reasons: [], serialRead: null },
              ],
              notes: "mock",
            }
          : {
              recommendation: "APPROVE_FULL",
              proposedRefundCents: 34000,
              citedClauses: [{ clauseId: "4.2", quote: "A kit is refunded in full only when every component listed on the packing slip is returned." }],
              rationale: "All three components seen (mock).",
              lineNotes: [],
            };
      const images = j.messages[1].content.filter((p) => p.type === "image_url").length;
      calls.push(`  ${name}: ${images} images`);
      return send(res, 200, {
        id: "chat_mock",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(content) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1000 + images * 500, completion_tokens: 200 },
      });
    }
    if (req.url === "/__calls") return send(res, 200, calls);
    send(res, 404, { error: { message: `mock has no ${req.method} ${req.url}` } });
  })
  .listen(PORT, () => console.log(`mock meta on ${PORT}`));
