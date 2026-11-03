import { FixtureLabel } from "@/components/ModeBadge";
import { KIT, KIT_TOTAL_CENTS } from "@/data/kit.config";
import { FIXTURE_LABEL, POLICY, RMAS, lensItem } from "@/data/fixtures";
import { formatCents } from "@/lib/format";
import styles from "./HomeHero.module.css";

/**
 * The home hero's one picture: the open box → the inspected tray → the lens line 0/1 → $340 HELD → a person decides.
 * It is a diagram of the seeded RMA-20418 scenario, not model output; the Instant Demo labels its own evidence.
 * Every name and price comes from data/kit.config.ts and data/fixtures.ts.
 */
export function HomeHeroPicture() {
  const rma = RMAS[0];
  const counted = KIT.items.filter((i) => i.key !== lensItem.key);
  const clause = POLICY.clauses.find((c) => c.id === "4.2");
  const summary = `Diagram of ${rma.id}: the box held ${counted.map((i) => i.name.toLowerCase()).join(" and ")}. ${counted.length} of ${KIT.items.length} kit items were counted in the inspected tray; the ${lensItem.name.toLowerCase()} line reads 0 of 1. The whole ${formatCents(rma.requestedRefundCents)} refund is held and waits for a person to decide.`;

  return (
    <figure className={styles.picture} aria-labelledby="home-picture-caption">
      <div className={styles.pictureHead}>
        <span className="eyebrow">
          <span className="mono">{rma.id}</span> · {KIT.kitName} · {formatCents(KIT_TOTAL_CENTS)}
        </span>
      </div>

      <p className="sr-only">{summary}</p>

      <ol className={styles.path} aria-hidden="true">
        <li className={styles.cell}>
          <span className={styles.index}>01 · The open box</span>
          <div className={styles.box}>
            {counted.map((i) => (
              <span key={i.key} className={styles.chip}>{i.name}</span>
            ))}
            <span className={`${styles.chip} ${styles.chipPacking}`}>Kraft paper · never counted</span>
          </div>
        </li>

        <li className={styles.arrow}>→</li>

        <li className={styles.cell}>
          <span className={styles.index}>02 · The inspected tray</span>
          <div className={styles.tray}>
            {KIT.items.map((i) => {
              const missing = i.key === lensItem.key;
              return (
                <span key={i.key} className={`${styles.slot} ${missing ? styles.slotEmpty : ""}`}>
                  <span>{i.name}</span>
                  <span className="mono">{missing ? "0/1" : "1/1"}</span>
                </span>
              );
            })}
          </div>
          <strong className={styles.tally}>
            {counted.length} of {KIT.items.length} counted
          </strong>
        </li>
      </ol>

      <div className={styles.lensLine} aria-hidden="true">
        <span className={styles.index}>03 · Packing-slip line</span>
        <div className={styles.lensRow}>
          <span className={styles.lensName}>
            {lensItem.name} <span className="mono muted">· {formatCents(lensItem.unitPriceCents)}</span>
          </span>
          <span className={styles.lensCount}>0/1</span>
          <span className="st st-missing">not observed in the tray</span>
        </div>
      </div>

      <div className={styles.decision} aria-hidden="true">
        <div className={styles.decisionCell}>
          <span className={styles.index}>04 · The refund</span>
          <div className={styles.money}>
            <span className={styles.moneyNum}>{formatCents(rma.requestedRefundCents)}</span>
            <span className="sticker-held">HELD</span>
          </div>
          {clause && (
            <span className={styles.note}>
              The whole refund, under clause {clause.id}: {clause.title.toLowerCase()} refund in full only when every component is returned.
            </span>
          )}
        </div>
        <span className={styles.arrow}>→</span>
        <div className={`${styles.decisionCell} ${styles.person}`}>
          <span className={styles.index}>05 · A person decides</span>
          <strong className={styles.personLine}>Only a person&apos;s single-use approval releases a refund.</strong>
          <span className={styles.note}>A hold is not a denial. No model can approve the money.</span>
        </div>
      </div>

      <figcaption id="home-picture-caption" className={styles.caption}>
        <span>Diagram of the seeded return, not model output. The Instant Demo replays the recorded run and labels every result.</span>
        <FixtureLabel>{FIXTURE_LABEL}</FixtureLabel>
      </figcaption>
    </figure>
  );
}

const ANSWERS: Array<{ k: string; v: string }> = [
  {
    k: "The problem",
    v: "In this scenario, a “received” scan would release the refund, not what was in the box, so an incomplete kit refunds in full.",
  },
  {
    k: "The solution",
    v: "SAM 3.1 tracks each item, app code counts what settles in the tray against the packing slip, and the refund holds until a person approves.",
  },
  {
    k: "Why it matters",
    v: `The missing ${formatCents(lensItem.unitPriceCents)} ${lensItem.name.toLowerCase()} is caught at the bench, with a timestamped record, not at a restock count later.`,
  },
  {
    k: "How it’s used",
    v: "Pick the RMA, unbox one item at a time into the tray, read the lines, then approve or keep the hold.",
  },
];

/** The four answers, one compact line each (the picture above carries the detail). */
export function HomeAnswers() {
  return (
    <dl className={styles.answers} aria-label="The problem, the solution, why it matters and how it is used">
      {ANSWERS.map((a) => (
        <div key={a.k} className={styles.answer}>
          <dt className="eyebrow">{a.k}</dt>
          <dd>{a.v}</dd>
        </div>
      ))}
    </dl>
  );
}
