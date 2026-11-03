"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ThemeToggle } from "./ThemeToggle";

const LANDING_ANCHORS = [
  { href: "#problem", label: "Problem" },
  { href: "#how", label: "How it works" },
  { href: "#proof", label: "Example" },
  { href: "#pricing", label: "Pricing" },
];

const ROUTE_LINKS = [
  { href: "/", label: "Home" },
  { href: "/demo", label: "Demo" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/pricing", label: "Pricing" },
];

export function Nav() {
  const pathname = usePathname();
  const isLanding = pathname === "/";
  const links = isLanding ? LANDING_ANCHORS : ROUTE_LINKS;
  const [open, setOpen] = useState(false);
  const active = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <header className="nav">
      <div className="container">
        <div className="nav-inner">
          <Link href="/" className="brand" aria-label="ReturnWitness home">
            <span className="brand-mark" aria-hidden />
            ReturnWitness
          </Link>
          <nav className="nav-links" aria-label="Primary">
            {links.map((l) => (
              <a key={l.href} href={l.href} aria-current={!isLanding && active(l.href) ? "page" : undefined}>
                {l.label}
              </a>
            ))}
          </nav>
          <div className="nav-right">
            {isLanding && (
              <Link href="/demo" className="btn btn-primary btn-sm nav-cta" aria-label="Run the Instant Demo">
                <span className="nav-cta-long">Run the Instant Demo</span>
                <span className="nav-cta-short" aria-hidden>
                  Demo
                </span>
              </Link>
            )}
            <ThemeToggle />
            <button type="button" className="icon-btn nav-menu-btn" aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen((o) => !o)}>
              {open ? "CLOSE" : "MENU"}
            </button>
          </div>
        </div>
        {open && (
          <nav id="mobile-nav" className="nav-mobile" aria-label="Mobile">
            {links.map((l) => (
              <a key={l.href} href={l.href} onClick={() => setOpen(false)}>
                {l.label}
              </a>
            ))}
            {isLanding && (
              <a href="/dashboard" onClick={() => setOpen(false)}>
                Dashboard
              </a>
            )}
          </nav>
        )}
      </div>
    </header>
  );
}

/** Shown while the route is resolved (the active link depends on the URL). */
export function NavFallback() {
  return (
    <header className="nav">
      <div className="container">
        <div className="nav-inner">
          <Link href="/" className="brand" aria-label="ReturnWitness home">
            <span className="brand-mark" aria-hidden />
            ReturnWitness
          </Link>
          <nav className="nav-links" aria-label="Primary">
            {ROUTE_LINKS.map((l) => (
              <a key={l.href} href={l.href}>
                {l.label}
              </a>
            ))}
          </nav>
          <div className="nav-right">
            <ThemeToggle />
          </div>
        </div>
      </div>
    </header>
  );
}
