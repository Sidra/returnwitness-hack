/**
 * A replay of a recorded real run counts as the live run did: SAM masks carry no text, so the counter's own label
 * check is off (otherwise every serial item on real footage replays as "no label read" and holds). Synthetic scenes
 * without a recording keep the fixture config, label check on.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveRecording } from "@/lib/meta/recordings";
import { pipelineDeps } from "@/lib/runtime";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-replay-cfg-"));
const prev = process.env.RETURNWITNESS_RECORDINGS_DIR;

beforeAll(() => {
  process.env.RETURNWITNESS_RECORDINGS_DIR = dir;
  saveRecording("real-clip", "sam", { clipId: "real-clip", fps: 5, frames: [], source: { mode: "LIVE_META", provenance: "test" } });
});
afterAll(() => {
  if (prev === undefined) delete process.env.RETURNWITNESS_RECORDINGS_DIR;
  else process.env.RETURNWITNESS_RECORDINGS_DIR = prev;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("counter config for replays", () => {
  it("a clip with a recorded SAM run replays with the label check off, like the live run", () => {
    expect(pipelineDeps({ liveModels: false, liveSegmentation: false, clipId: "real-clip" }).counterConfig.checkLabels).toBe(false);
  });
  it("a synthetic scene with no recording keeps the fixture config (label check on)", () => {
    expect(pipelineDeps({ liveModels: false, liveSegmentation: false, clipId: "no-such-clip" }).counterConfig.checkLabels).toBe(true);
  });
});
