"use client";

import { useSyncExternalStore } from "react";

const noop = () => () => {};

/**
 * A timestamp in the viewer's own time zone, without a hydration mismatch: the server (UTC) and the first client
 * render both print the UTC text; once hydrated, the browser's local formatting takes over.
 */
export function LocalTime({ iso, mode = "time" }: { iso: string; mode?: "time" | "datetime" }) {
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  return <time dateTime={iso}>{formatTime(iso, mode, hydrated ? undefined : "UTC")}</time>;
}

/** Pure formatting, exported for tests: `timeZone` "UTC" appends the zone so a UTC time never passes as local. */
export function formatTime(iso: string, mode: "time" | "datetime", timeZone?: "UTC"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const s = mode === "time" ? d.toLocaleTimeString("en-US", { timeZone }) : d.toLocaleString("en-US", { timeZone });
  return timeZone ? `${s} UTC` : s;
}
