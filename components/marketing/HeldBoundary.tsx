/** What a HELD shows and what it doesn't. Shared by the landing page and /how-it-works. */
export function HeldBoundary({ headingLevel = 3 }: { headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className="stack" style={{ gap: 20 }}>
      <H className={headingLevel === 2 ? "h2" : "h3"}>What a HELD shows, and what it doesn&apos;t</H>
      <div className="cols-3">
        <div className="card">
          <span className="eyebrow">What the record shows</span>
          <p style={{ margin: "8px 0 0" }}>
            No accepted arrival of that item in the tray during this clip, or something the camera couldn&apos;t resolve: two items merged into
            one, a label it couldn&apos;t read. A hold is a question for a person, not proof the customer kept anything.
          </p>
        </div>
        <div className="card">
          <span className="eyebrow">What it doesn&apos;t show</span>
          <p style={{ margin: "8px 0 0" }}>
            That the customer kept the item, that an item it did see is genuine, or that there is no hidden damage. A brick the shape of a lens is
            out of scope, and so is anything inside a sealed box.
          </p>
        </div>
        <div className="card">
          <span className="eyebrow">So it never denies</span>
          <p style={{ margin: "8px 0 0" }}>
            It holds the refund, attaches timestamped evidence and the policy clause, and a person decides. Under clause 5.1 a hold is not a denial.
          </p>
        </div>
      </div>
    </div>
  );
}
