// Plain constants, safe in client components (agent-guard.ts imports node:crypto).
/**
 * The decision agent's bounds, as app controls (the model is told them; app code enforces them):
 * model rounds per run, evidence requests per run, and the wall-clock deadline for the agent's work.
 * Past any of them the run ends: the case stays where app code put it (HELD if any line is not OK)
 * and the draft is the deterministic template.
 */
export const AGENT_LIMITS = { maxModelRounds: 4, maxEvidenceRequests: 2, deadlineMs: 60_000 } as const;
