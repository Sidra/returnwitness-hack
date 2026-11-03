"use client";

import { useEffect, useState } from "react";
import type { Illustration } from "@/lib/meta/image";
import { ModeBadge } from "@/components/ModeBadge";
import { KIT, KIT_ID } from "@/data/kit.config";

/**
 * "What a complete return looks like": a Muse Image 1.0 layout of the kit, drawn from generic item concepts
 * only (never a real product), so a new bench worker knows what should be on the mat. Replayed from the
 * saved live result, labelled; when none exists yet, the card says so.
 */
export function CompleteKitCard() {
  const [ill, setIll] = useState<Illustration | null | undefined>(undefined);
  useEffect(() => {
    fetch(`/illustrations/${KIT_ID}.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Illustration>) : null))
      .then((j) => setIll(j ? { ...j, mode: "RECORDED_FIXTURE" } : null))
      .catch(() => setIll(null));
  }, []);
  if (ill === undefined) return null;
  return (
    <div className="card-flat stack" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="eyebrow">What a complete return looks like</span>
        {ill ? <ModeBadge mode={ill.mode} title="recorded Muse Image output" replay={ill.mode === "RECORDED_FIXTURE" ? { model: ill.model, at: ill.createdAt } : undefined} /> : <span className="mode mode-det">NOT GENERATED YET</span>}
      </div>
      {ill ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={ill.imagePath} alt={`Generated illustration: a generic layout of a complete ${KIT.kitName} (${KIT.items.map((i) => i.genericName).join(", ")})`} style={{ width: "100%", height: "auto", borderRadius: 12, border: "1px solid var(--line)" }} />
          <span className="fixture-label">Generated illustration · {ill.model} · generic, unbranded items, not photos of the real products</span>
        </>
      ) : (
        <span className="muted" style={{ fontSize: 14 }}>
          One Muse Image 1.0 call ($0.01) draws a generic, unbranded layout of the {KIT.items.length} items on this slip ({KIT.items.map((i) => i.genericName).join(", ")}), so a new bench worker knows what should be on the mat.
        </span>
      )}
    </div>
  );
}
