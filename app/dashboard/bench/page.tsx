import type { Metadata } from "next";
import { BenchFromQuery } from "./BenchFromQuery";

export const metadata: Metadata = { title: "Bench station" };

export default function BenchPage() {
  return (
    <>
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <span className="eyebrow">Bench 2 · overhead camera</span>
          <h1 className="h1">Bench station</h1>
          <p className="muted" style={{ margin: 0, maxWidth: "64ch" }}>
            Pick the return, unbox one item at a time from the box side to the tray side, then inspect. Anything missing, merged or unreadable is held for a person.
          </p>
        </div>
      </div>
      <BenchFromQuery />
    </>
  );
}
