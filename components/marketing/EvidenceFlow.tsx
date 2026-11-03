import type { ReactNode } from "react";
import type { KnownMisread } from "@/data/known-misreads";
import styles from "./EvidenceFlow.module.css";

/** A number measured on a real run, with where it came from. Never pass an estimate here. */
export interface FlowFact {
  value: string;
  label: string;
  source: string;
}

/** A statement about a real result; its losses render directly under it, never collapsed. */
export interface FlowNote {
  /** Who said or produced it (e.g. "Open-weight auditor · d2"). */
  who?: string;
  text: ReactNode;
  /** Provenance of this statement, verbatim (a badge or a label string). */
  provenance?: ReactNode;
  /** Known misreads that correct the words in `text` (data/known-misreads.ts). */
  misreads?: KnownMisread[];
  /** Any other loss line that corrects this statement, verbatim. */
  losses?: string[];
}

export interface FlowStep {
  id: string;
  n: string;
  /** The job, as a short verb phrase: "SAM 3.1 tracks". */
  title: string;
  /** Who does it, short, for the chain strip. */
  who: string;
  /** The one answer this step gives. */
  job: string;
  /** What this step can and cannot do. */
  limit?: string;
  /** What produces this step's output on this public server (full provenance labels). */
  onServer: ReactNode;
  facts?: FlowFact[];
  notes?: FlowNote[];
  /** The hold boundary step gets the accent rule. */
  boundary?: boolean;
}

function Loss({ text }: { text: string }) {
  return (
    <p className={`loss-note ${styles.loss}`}>
      <span className="loss-tag">Loss</span> {text}
    </p>
  );
}

/**
 * The six jobs from evidence to money, in causal order. Server-rendered and static: it shows recorded results and
 * their provenance; it calls nothing. Every measured number arrives as data with its source; a step without a
 * measurement shows none.
 */
export function EvidenceFlow({ steps, intro, summary }: { steps: FlowStep[]; intro: ReactNode; summary?: ReactNode }) {
  return (
    <section className={`container section ${styles.flow}`} aria-labelledby="evidence-flow-title">
      <div className={styles.head}>
        <span className="eyebrow">Evidence → hold → a person → money</span>
        <h2 className="h2" id="evidence-flow-title">
          Six jobs, in order. A model can add a hold; only a person releases money.
        </h2>
        <div className={styles.intro}>{intro}</div>
      </div>

      <ol className={styles.chain} aria-label="The six jobs, in order">
        {steps.map((s) => (
          <li key={s.id} className={s.boundary ? styles.chainBoundary : undefined}>
            <a href={`#${s.id}`} className={styles.chainLink}>
              <span className={styles.chainN} aria-hidden>
                {s.n}
              </span>
              <span className={styles.chainTitle}>{s.title}</span>
              <span className={styles.chainWho}>{s.who}</span>
            </a>
          </li>
        ))}
      </ol>

      {summary && <div className={styles.summary}>{summary}</div>}

      <ol className={styles.steps}>
        {steps.map((s) => (
          <li key={s.id} id={s.id} className={`${styles.step} ${s.boundary ? styles.stepBoundary : ""}`}>
            <div className={styles.rail} aria-hidden>
              <span className={styles.railN}>{s.n}</span>
            </div>
            <div className={styles.what}>
              <h3 className={styles.title}>
                <span className="sr-only">Job {s.n}: </span>
                {s.title}
              </h3>
              <p className={styles.job}>{s.job}</p>
              {s.limit && <p className={styles.limit}>{s.limit}</p>}
              <div className={styles.onServer}>
                <span className={styles.kicker}>On this public server</span>
                <div className={styles.badges}>{s.onServer}</div>
              </div>
            </div>
            <div className={styles.evidence}>
              {s.facts && s.facts.length > 0 && (
                <dl className={styles.facts}>
                  {s.facts.map((f) => (
                    <div key={`${f.value}-${f.label}`} className={styles.fact}>
                      <dt className={styles.factLabel}>{f.label}</dt>
                      <dd className={styles.factValue}>{f.value}</dd>
                      <dd className={styles.factSource}>{f.source}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {s.notes?.map((note, i) => (
                <div key={i} className={styles.note}>
                  {note.who && <span className={styles.noteWho}>{note.who}</span>}
                  <p className={styles.noteText}>{note.text}</p>
                  {note.misreads?.map((m) => <Loss key={m.id} text={m.loss} />)}
                  {note.losses?.map((l) => <Loss key={l} text={l} />)}
                  {note.provenance && <div className={styles.noteProv}>{note.provenance}</div>}
                </div>
              ))}
              {!s.facts?.length && !s.notes?.length && <p className={styles.noMeasure}>No measured number for this step.</p>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
