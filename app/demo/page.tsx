import type { Metadata } from "next";
import Link from "next/link";
import { DemoFlow } from "@/components/dash/DemoFlow";

export const metadata: Metadata = { title: "Instant Demo" };

export default function DemoPage() {
  return (
    <div className="container section" style={{ paddingTop: 40 }}>
      <div className="page-head">
        <div className="stack" style={{ gap: 8 }}>
          <span className="eyebrow">Guided demo · Brindlewood Camera Co. · Bench 2</span>
          <h1 className="h1">Watch a $340 refund wait for what&apos;s in the box</h1>
          <p className="lead">Two returns of the same three-item kit. One is missing the lens. One is complete. Neither refunds until a person says so.</p>
          <p className="muted" style={{ margin: 0, fontSize: 15 }}>
            Want to be the customer? <Link href="/play">Return a box yourself</Link>: unpack it, swap in a look-alike, and watch the same rules decide.
          </p>
        </div>
      </div>
      <DemoFlow />
    </div>
  );
}
