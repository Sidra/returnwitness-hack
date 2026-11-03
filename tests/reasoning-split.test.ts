import { describe, expect, it } from "vitest";
import { firstJsonObject, splitReasoning } from "@/lib/openweights/reasoning";

describe("Muse Spark Open reasoning split", () => {
  it("takes reasoning from a separate field (Baseten's reasoning_content) and leaves content as the answer", () => {
    const s = splitReasoning({ content: '{"items":[]}', reasoning_content: 'They want {"items":[{"itemKey":"lens"}]} maybe.' });
    expect(s).toEqual({ answer: '{"items":[]}', reasoning: 'They want {"items":[{"itemKey":"lens"}]} maybe.', source: "field" });
  });

  it("also reads a `reasoning` field", () => {
    expect(splitReasoning({ content: "{}", reasoning: "hmm" }).source).toBe("field");
  });

  it("strips <think> blocks out of content", () => {
    const s = splitReasoning({ content: '<think>draft {"items":[{"itemKey":"x"}]}</think>\n{"items":[]}' });
    expect(s.answer).toBe('{"items":[]}');
    expect(s.reasoning).toBe('draft {"items":[{"itemKey":"x"}]}');
    expect(s.source).toBe("think-tags");
  });

  it("handles a dangling </think> with no opening tag", () => {
    const s = splitReasoning({ content: 'scratch {"a":1}</think>{"a":2}' });
    expect(s.answer).toBe('{"a":2}');
    expect(s.source).toBe("think-tags");
  });

  it("reports none when there is no reasoning, and survives a missing message", () => {
    expect(splitReasoning({ content: '{"a":1}' }).source).toBe("none");
    expect(splitReasoning(undefined)).toEqual({ answer: "", reasoning: "", source: "none" });
  });

  it("parses fenced JSON, then falls back to the first balanced object, ignoring braces inside strings", () => {
    expect(firstJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(firstJsonObject('Answer: {"note":"has } brace","b":[1,2]} trailing {"c":3}')).toEqual({ note: "has } brace", b: [1, 2] });
    expect(firstJsonObject("no json here")).toBeNull();
  });
});
