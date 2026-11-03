"use client";

import { useEffect, useState } from "react";

export const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

/** Seconds since `fromIso`, ticking while `active`. */
export function useElapsed(fromIso: string | undefined, active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  if (!fromIso) return 0;
  return Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000));
}
