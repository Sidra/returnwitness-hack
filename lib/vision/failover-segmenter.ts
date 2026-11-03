/**
 * Primary segmenter with a fallback on failure (Meta's hosted SAM 3.1 → SAM 3.1 open weights on Modal).
 *
 * The primary gets a time budget; on an error OR a timeout the fallback runs and its result is returned
 * with the reason prefixed to its provenance, so the case shows WHY a different engine answered. The
 * result's own `source.mode` is kept (LIVE_OPEN_WEIGHTS after a failover), and the pipeline takes the
 * clip's mode from the result, so a failover is never shown as "LIVE · Meta".
 * Each segmenter logs its own calls; this wrapper logs nothing extra. Both failing is a throw, which the
 * pipeline turns into a HELD case (never an approval).
 * A caller's abort is not a failure: it is passed through and the fallback is not spent.
 */
import type { ModeLabel, SegmentationResult } from "@/lib/domain/schemas";
import type { SegmentInput, Segmenter } from "./segmenter";

export class SegmenterTimeoutError extends Error {}

const short = (e: unknown, n = 140): string => {
  const m = (e instanceof Error ? e.message : String(e)).split("\n")[0].trim() || "unknown error";
  return m.length > n ? `${m.slice(0, n)}…` : m;
};

export class FailoverSegmenter implements Segmenter {
  readonly name: string;
  readonly mode: ModeLabel;

  constructor(
    private readonly primary: Segmenter,
    private readonly fallback: Segmenter,
    private readonly opts: { timeoutMs: number },
  ) {
    if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error(`failover timeoutMs must be > 0 (got ${opts.timeoutMs})`);
    this.name = `${primary.name} → ${fallback.name} on failure`;
    this.mode = primary.mode;
  }

  async segment(input: SegmentInput): Promise<SegmentationResult> {
    if (input.signal?.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new Error("segmentation aborted by caller");
    let primaryFailure: string;
    try {
      return await this.runPrimary(input);
    } catch (e) {
      if (input.signal?.aborted) throw e;
      primaryFailure = short(e);
    }
    try {
      const r = await this.fallback.segment(input);
      return { ...r, source: { ...r.source, provenance: `failover: ${this.primary.name} failed (${primaryFailure}) → ${r.source.provenance}` } };
    } catch (e) {
      throw new Error(`segmentation failed on both engines: ${this.primary.name}: ${primaryFailure}; ${this.fallback.name}: ${short(e)}`);
    }
  }

  /** The primary with its own AbortController: aborted on timeout or when the caller aborts. */
  private async runPrimary(input: SegmentInput): Promise<SegmentationResult> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new SegmenterTimeoutError(`timed out after ${this.opts.timeoutMs} ms`)), this.opts.timeoutMs);
    const onOuter = () => ctl.abort(input.signal?.reason ?? new Error("segmentation aborted by caller"));
    input.signal?.addEventListener("abort", onOuter, { once: true });
    // A primary that ignores its signal still loses the race; its late rejection is swallowed.
    const aborted = new Promise<never>((_, reject) => ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason), { once: true }));
    aborted.catch(() => {});
    try {
      const work = this.primary.segment({ ...input, signal: ctl.signal });
      work.catch(() => {});
      return await Promise.race([work, aborted]);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onOuter);
      // If the primary failed fast, still cancel anything it left in flight.
      if (!ctl.signal.aborted) ctl.abort(new Error("primary finished"));
    }
  }
}
