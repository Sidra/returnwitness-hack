/**
 * Timestamps render the same text on the server (UTC) and in the first client render, so React never sees a
 * hydration mismatch; the UTC text says UTC, so it is never mistaken for the viewer's local time.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatTime, LocalTime } from "@/components/LocalTime";

const ISO = "2026-11-03T20:05:09.000Z";

describe("LocalTime", () => {
  it("server render: UTC text, labelled, with a machine-readable dateTime", () => {
    const html = renderToStaticMarkup(createElement(LocalTime, { iso: ISO }));
    expect(html).toBe(`<time dateTime="${ISO}">8:05:09 PM UTC</time>`);
    expect(renderToStaticMarkup(createElement(LocalTime, { iso: ISO, mode: "datetime" }))).toContain("11/3/2026, 8:05:09 PM UTC");
  });

  it("the same input always gives the same UTC text, whatever the machine's zone", () => {
    expect(formatTime(ISO, "time", "UTC")).toBe("8:05:09 PM UTC");
  });

  it("an unparseable value is shown as given, never as Invalid Date", () => {
    expect(formatTime("not a date", "time", "UTC")).toBe("not a date");
  });
});
