"use client";

import { useCallback, useSyncExternalStore } from "react";

const EVENT = "rw-storage";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** A localStorage value as React state, safe for SSR (falls back on the server and when storage is blocked). */
export function useStoredValue(key: string, fallback: string): [string, (v: string) => boolean] {
  const subscribe = useCallback((cb: () => void) => {
    window.addEventListener("storage", cb);
    window.addEventListener(EVENT, cb);
    return () => {
      window.removeEventListener("storage", cb);
      window.removeEventListener(EVENT, cb);
    };
  }, []);
  const value = useSyncExternalStore(subscribe, () => read(key) ?? fallback, () => fallback);
  const set = useCallback(
    (v: string) => {
      try {
        localStorage.setItem(key, v);
        window.dispatchEvent(new Event(EVENT));
        return true;
      } catch {
        return false;
      }
    },
    [key],
  );
  return [value, set];
}

/** The current <html data-theme>, kept in sync. */
export function useThemeAttr(): "dark" | "light" | null {
  return useSyncExternalStore(
    (cb) => {
      const mo = new MutationObserver(cb);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      return () => mo.disconnect();
    },
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
    () => null,
  );
}
