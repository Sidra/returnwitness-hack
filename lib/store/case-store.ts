/**
 * Case storage behind an interface (ADR-003). The default keeps cases in memory and mirrors
 * them to `.data/store.json` so a dev restart doesn't lose the queue. A Postgres adapter
 * slots in behind the same interface for a multi-instance deploy.
 *
 * Three guarantees every adapter must keep:
 *  - `put` is optimistic: it fails if the case changed since it was read (version check).
 *  - `consumeNonce` is atomic: a nonce can be spent exactly once.
 *  - `claimWebhookEvent` is atomic and persistent: a Stripe event id is processed once.
 */
import fs from "node:fs";
import path from "node:path";
import type { ReturnCase } from "@/lib/domain/case";
import { kv } from "./kv";
import { RedisCaseStore } from "./redis-store";

import { VersionConflict } from "./errors";
export { VersionConflict };

export interface CaseStore {
  get(id: string): Promise<ReturnCase | null>;
  list(): Promise<ReturnCase[]>;
  /** Insert (expectedVersion = 0) or update (expectedVersion = the version you read). Returns the stored case. */
  put(c: ReturnCase, expectedVersion: number): Promise<ReturnCase>;
  /** True the first time a nonce is consumed, false every time after. */
  consumeNonce(nonce: string): Promise<boolean>;
  /** True the first time a webhook event id is claimed (dedup across instances and restarts). */
  claimWebhookEvent(eventId: string): Promise<boolean>;
  /** Un-claim an event whose processing failed, so Stripe's redelivery is processed. */
  releaseWebhookEvent(eventId: string): Promise<void>;
  reset(): Promise<void>;
  readonly kind: string;
}

interface Snapshot {
  cases: Record<string, ReturnCase>;
  nonces: string[];
  webhookEvents?: string[];
}

export class MemoryCaseStore implements CaseStore {
  readonly kind: string;
  private cases = new Map<string, ReturnCase>();
  private nonces = new Set<string>();
  private webhookEvents = new Set<string>();

  constructor(private readonly file: string | null = null) {
    this.kind = file ? "memory+file" : "memory";
    if (file) this.load();
  }

  async get(id: string) {
    const c = this.cases.get(id);
    return c ? structuredClone(c) : null;
  }

  async list() {
    return [...this.cases.values()].map((c) => structuredClone(c)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async put(c: ReturnCase, expectedVersion: number) {
    const cur = this.cases.get(c.id);
    const actual = cur?.version ?? 0;
    if (actual !== expectedVersion) throw new VersionConflict(c.id, expectedVersion, actual);
    const stored = structuredClone({ ...c, version: actual + 1 });
    this.cases.set(c.id, stored);
    this.save();
    return structuredClone(stored);
  }

  async consumeNonce(nonce: string) {
    if (!nonce || this.nonces.has(nonce)) return false;
    this.nonces.add(nonce);
    this.save();
    return true;
  }

  async claimWebhookEvent(eventId: string) {
    if (!eventId || this.webhookEvents.has(eventId)) return false;
    this.webhookEvents.add(eventId);
    this.save();
    return true;
  }

  async releaseWebhookEvent(eventId: string) {
    if (this.webhookEvents.delete(eventId)) this.save();
  }

  async reset() {
    this.cases.clear();
    this.nonces.clear();
    this.webhookEvents.clear();
    this.save();
  }

  private load() {
    if (!this.file) return;
    try {
      const snap = JSON.parse(fs.readFileSync(this.file, "utf8")) as Snapshot;
      for (const [k, v] of Object.entries(snap.cases ?? {})) this.cases.set(k, v);
      for (const n of snap.nonces ?? []) this.nonces.add(n);
      for (const e of snap.webhookEvents ?? []) this.webhookEvents.add(e);
    } catch {
      // No file yet, or unreadable: start empty. Spent nonces live in the same file, so an
      // unreadable file can't resurrect a token whose case is also gone.
    }
  }

  private save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const snap: Snapshot = { cases: Object.fromEntries(this.cases), nonces: [...this.nonces], webhookEvents: [...this.webhookEvents] };
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snap));
      fs.renameSync(tmp, this.file);
    } catch {
      // Read-only filesystem (serverless): memory only. The kind label says so on /settings.
    }
  }
}

const g = globalThis as unknown as { __rwStore?: CaseStore };

export function getStore(): CaseStore {
  if (!g.__rwStore) {
    const r = kv();
    if (r) {
      g.__rwStore = new RedisCaseStore(r);
      return g.__rwStore;
    }
    const onServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
    const file = process.env.RETURNWITNESS_STORE === "memory" || onServerless ? null : path.join(process.cwd(), ".data", "store.json");
    g.__rwStore = new MemoryCaseStore(file);
  }
  return g.__rwStore;
}

/** Tests only. */
export function setStore(s: CaseStore) {
  g.__rwStore = s;
}
