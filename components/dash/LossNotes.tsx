import type { KnownMisread } from "@/data/known-misreads";

/** A model's known misread, stated as a loss right beside its words (data/known-misreads.ts). */
export function LossNotes({ items, compact = false }: { items: KnownMisread[]; compact?: boolean }) {
  if (!items.length) return null;
  return (
    <>
      {items.map((m) => (
        <div key={m.id} className="loss-note" style={compact ? { fontSize: 13 } : undefined}>
          <span className="loss-tag">Loss</span> {m.loss}
        </div>
      ))}
    </>
  );
}

/** Every known misread on this clip, listed once above the result. */
export function KnownMisreadsBanner({ items }: { items: KnownMisread[] }) {
  if (!items.length) return null;
  return (
    <section className="loss-banner stack" style={{ gap: 6 }} aria-label="Known misreads on this clip">
      <strong>Known misreads on this clip, kept as losses</strong>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {items.map((m) => (
          <li key={m.id} style={{ fontSize: 14 }}>
            {m.by.join(", ")} said &ldquo;{m.said}&rdquo; ({m.itemKey}): <strong>{m.loss}</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}
