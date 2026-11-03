/**
 * Human approval tokens. A token is issued when a person approves an amount for one case and
 * is bound to a digest of that exact RMA + observation + reconciliation + amount. It is
 * HMAC-signed, expires, and its nonce can be spent once. The refund endpoint accepts nothing else.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface ApprovalPayload {
  v: 1;
  caseId: string;
  rmaId: string;
  digest: string;
  amountCents: number;
  approver: string;
  nonce: string;
  iat: number;
  exp: number;
}

export type VerifyError = "malformed" | "bad_signature" | "expired" | "wrong_case";

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest();

export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export function requireSecret(secret: string | undefined): string {
  if (!secret || secret.length < 32) throw new Error("RETURNWITNESS_APPROVAL_SECRET missing or shorter than 32 chars");
  return secret;
}

export function issueToken(
  p: Omit<ApprovalPayload, "v" | "nonce" | "iat" | "exp">,
  secret: string,
  now = Date.now(),
  ttlMs = APPROVAL_TTL_MS,
): { token: string; payload: ApprovalPayload } {
  if (!Number.isInteger(p.amountCents) || p.amountCents < 0) throw new Error("amountCents must be a non-negative integer");
  const payload: ApprovalPayload = { v: 1, ...p, nonce: randomBytes(16).toString("hex"), iat: now, exp: now + ttlMs };
  const body = b64u(JSON.stringify(payload));
  return { token: `${body}.${b64u(sign(body, secret))}`, payload };
}

export function verifyToken(
  token: string,
  secret: string,
  expectCaseId: string,
  now = Date.now(),
): { ok: true; payload: ApprovalPayload } | { ok: false; error: VerifyError } {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: "malformed" };
  const [body, sig] = parts;
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return { ok: false, error: "malformed" };
  }
  const want = sign(body, secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, error: "bad_signature" };
  let payload: ApprovalPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (payload?.v !== 1 || typeof payload.exp !== "number" || typeof payload.nonce !== "string") return { ok: false, error: "malformed" };
  if (payload.caseId !== expectCaseId) return { ok: false, error: "wrong_case" };
  if (now >= payload.exp) return { ok: false, error: "expired" };
  return { ok: true, payload };
}
