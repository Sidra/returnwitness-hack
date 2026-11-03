"use client";

import { useThemeAttr } from "@/lib/client/storage";

export function ThemeToggle() {
  const theme = useThemeAttr();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={theme ? `Switch to ${next} theme` : "Switch theme"}
      title={theme ? `Switch to ${next} theme` : "Switch theme"}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("rw-theme", next);
        } catch {
          /* storage blocked: theme still switches for this page */
        }
      }}
    >
      {theme === "light" ? "DARK" : "LIGHT"}
    </button>
  );
}
