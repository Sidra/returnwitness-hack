/**
 * Muse Spark Open always reasons. Providers carry that reasoning in one of two ways: a separate
 * message field (Baseten returns `reasoning_content`; some servers use `reasoning`), or inline in
 * `content` wrapped in <think>…</think>. The answer we parse must never include the reasoning: it
 * quotes the prompt and drafts JSON of its own, so a greedy "first { to last }" match would mix the
 * model's scratch work into the audit.
 */

export type ReasoningSource = "field" | "think-tags" | "none";

export interface SplitAnswer {
  answer: string;
  reasoning: string;
  source: ReasoningSource;
}

const THINK_BLOCK = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
// Some servers drop the opening tag and stream only the close.
const DANGLING_CLOSE = /^([\s\S]*?)<\/think(?:ing)?>/i;

export function splitReasoning(message: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } | null | undefined): SplitAnswer {
  const content = typeof message?.content === "string" ? message.content : "";
  const field = [message?.reasoning_content, message?.reasoning].find((v): v is string => typeof v === "string" && v.trim().length > 0);
  const parts: string[] = field ? [field.trim()] : [];
  let answer = content.replace(THINK_BLOCK, (_, inner: string) => {
    parts.push(inner.trim());
    return "";
  });
  const dangling = DANGLING_CLOSE.exec(answer);
  if (dangling) {
    parts.push(dangling[1].trim());
    answer = answer.slice(dangling[0].length);
  }
  const tagged = parts.length > (field ? 1 : 0);
  return { answer: answer.trim(), reasoning: parts.filter(Boolean).join("\n\n"), source: tagged ? "think-tags" : field ? "field" : "none" };
}

/**
 * The first complete JSON object in the answer: the whole answer if it parses (code fences
 * stripped), else the first balanced {...} that parses. Returns null when there is none.
 */
export function firstJsonObject(answer: string): unknown {
  const unfenced = answer.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    // fall through to the scan
  }
  for (let start = unfenced.indexOf("{"); start !== -1; start = unfenced.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < unfenced.length; i++) {
      const ch = unfenced[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          return JSON.parse(unfenced.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return null;
}
