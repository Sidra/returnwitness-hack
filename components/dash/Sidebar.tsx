"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { caseCounts } from "@/lib/client/cases";

const LINKS = [
  { href: "/dashboard", label: "RMA queue", key: "queue" },
  { href: "/dashboard/bench", label: "Bench station", key: "bench" },
  { href: "/dashboard/agents", label: "Agents at work", key: "agents" },
  { href: "/dashboard/held", label: "Held returns", key: "held" },
  { href: "/dashboard/refunds", label: "Refunds", key: "refunds" },
  { href: "/dashboard/evals", label: "Evals", key: "evals" },
  { href: "/dashboard/settings", label: "Settings", key: "settings" },
] as const;

/** `initialCounts` comes from the server render so the badges are in the first HTML; the client keeps them fresh. */
export function Sidebar({ initialCounts }: { initialCounts?: { held: number; refunds: number } }) {
  const pathname = usePathname();
  const [counts, setCounts] = useState<{ held: number; refunds: number } | null>(initialCounts ?? null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .cases()
        .then((cs) => alive && setCounts(caseCounts(cs)))
        .catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pathname]);
  const current = (href: string) => (href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href));
  return (
    <aside className="sidebar">
      <nav aria-label="Dashboard">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} aria-current={current(l.href) ? "page" : undefined}>
            {l.label}
            {l.key === "held" && counts && counts.held > 0 && <span className="count st st-held">{counts.held}</span>}
            {l.key === "refunds" && counts && counts.refunds > 0 && <span className="count">{counts.refunds}</span>}
          </Link>
        ))}
      </nav>
    </aside>
  );
}

export function SidebarFallback() {
  return (
    <aside className="sidebar">
      <nav aria-label="Dashboard">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href}>
            {l.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
