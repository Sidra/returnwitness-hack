/**
 * Every test run starts with its own empty recordings dir and its own call log:
 * - a live run's recordings in data/recordings (real clips under the seeded RMAs' clip ids) never turn the synthetic
 *   scenes the tests assert on into replays of real footage;
 * - the tests' fake model calls never land in .data/llm-calls.jsonl, the spend log (581 fake Baseten audit rows did,
 *   before this; they were moved to .data/llm-calls.test-rows.jsonl);
 * - the tests' fake inspections never land in .data/decisions.jsonl, the learning loop's log (18,000+ did; the log was
 *   cut to the rows of real local cases, the rest kept in .data/decisions.test-rows.jsonl).
 * A test that needs one sets RETURNWITNESS_RECORDINGS_DIR / RETURNWITNESS_LLM_LOG / RETURNWITNESS_DECISION_LOG itself.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.RETURNWITNESS_RECORDINGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rw-test-recordings-"));
process.env.RETURNWITNESS_LLM_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rw-test-llm-log-")), "llm-calls.jsonl");
process.env.RETURNWITNESS_DECISION_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rw-test-decisions-")), "decisions.jsonl");
