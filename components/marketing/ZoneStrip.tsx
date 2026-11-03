/** Diagram of the tape layout on the mat: BOX left 45%, 10% gap, TRAY right 45%. */
export function ZoneStrip() {
  const zone = { border: "2px solid var(--line)", padding: "20px 12px", minHeight: 96, display: "flex", flexDirection: "column" as const, justifyContent: "center" };
  return (
    <figure style={{ margin: 0 }}>
      <div style={{ display: "flex", width: "100%" }} role="img" aria-label="Mat layout from the camera: BOX zone on the left 45 percent, a 10 percent gap, TRAY zone on the right 45 percent">
        <div style={{ ...zone, width: "45%", background: "var(--card)" }}>
          <strong>BOX</strong>
          <span className="mono muted" style={{ fontSize: 12 }}>left ~45%</span>
        </div>
        <div style={{ width: "10%", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span className="mono muted" style={{ fontSize: 11 }}>10%</span>
        </div>
        <div style={{ ...zone, width: "45%", background: "var(--card-2)", borderColor: "var(--accent)" }}>
          <strong>TRAY</strong>
          <span className="mono muted" style={{ fontSize: 12 }}>right ~45%</span>
        </div>
      </div>
      <figcaption className="muted" style={{ fontSize: 14, marginTop: 8 }}>
        View from the camera. Items come out of the box on the left and are counted once they settle on the right.
      </figcaption>
    </figure>
  );
}
