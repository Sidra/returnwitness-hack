import Link from "next/link";

export function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <div className="stack" style={{ gap: 8 }}>
          <span className="brand">
            <span className="brand-mark" aria-hidden />
            ReturnWitness
          </span>
          <p className="muted" style={{ margin: 0, maxWidth: "46ch", fontSize: 15 }}>
            The refund waits for what&apos;s actually in the box. Kit-completeness checks at the returns bench, with a person approving every refund.
          </p>
        </div>
        <div className="footer-links">
          <span className="eyebrow">Product</span>
          <Link href="/demo">Instant Demo</Link>
          <Link href="/play">Return a box yourself</Link>
          <Link href="/how-it-works">How it works</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/onboarding">Set up a bench</Link>
        </div>
        <div className="footer-links">
          <span className="eyebrow">App</span>
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/dashboard/bench">Bench station</Link>
          <Link href="/dashboard/held">Held returns</Link>
          <Link href="/dashboard/evals">Evals</Link>
        </div>
      </div>
      <div className="container" style={{ paddingBottom: 28 }}>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          © 2026 ReturnWitness ·{" "}
          <a href="https://x.com/SidraMiconi" target="_blank" rel="noopener noreferrer">
            @SidraMiconi
          </a>
        </p>
      </div>
    </footer>
  );
}
