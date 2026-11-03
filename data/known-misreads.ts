/**
 * Known model misreads on the filmed clips, stated as losses wherever the model's words are shown (case pages, replays,
 * the A/B, the fleet). A replay shows exactly what the model said; this file says where it was wrong. Added from the
 * independent honesty audit of the live run. Facts about the props: the "camera body" is a real
 * compact film camera standing in for the kit's interchangeable-lens body; the "zoom lens" is a camera-lens-shaped mug.
 */
export interface KnownMisread {
  id: string;
  clipId: string;
  itemKey: string;
  /** Who said it: the reader or agent whose words are shown. */
  by: string[];
  /** What the model said, short. */
  said: string;
  /** The loss line shown beside it. */
  loss: string;
  /** Text that marks the model's words for this misread in a reason, note or draft (case-insensitive). */
  match: RegExp;
}

const CAMERA_LOSS = "misread: the prop is a real compact film camera, not a toy (it stands in for the kit's interchangeable-lens body); a false stand-in flag";

export const KNOWN_MISREADS: KnownMisread[] = [
  {
    id: "d1-camera-toy",
    clipId: "d1-rma-20418-lens-missing",
    itemKey: "camera_body",
    by: ["open-weight auditor (Baseten)", "Muse Spark damage reader (fleet)", "Muse Wonder draft"],
    said: "the camera is a light-green toy truck",
    loss: CAMERA_LOSS,
    match: /toy (truck|car)|not a camera body/i,
  },
  {
    id: "d2-camera-toy",
    clipId: "d2-rma-20419-complete",
    itemKey: "camera_body",
    by: ["open-weight auditor (Baseten)", "Muse Spark damage reader (fleet)", "Muse Wonder draft"],
    said: "the camera is a toy car",
    loss: `${CAMERA_LOSS}; it held a complete kit (a false hold under the registered scoring)`,
    match: /toy (truck|car)|not a camera body/i,
  },
  {
    id: "d2-camera-serial",
    clipId: "d2-rma-20419-complete",
    itemKey: "camera_body",
    by: ["open-weight auditor (Baseten)", "Muse Spark label reader (fleet)"],
    said: "label BM-CB-55120",
    loss: "misread: the label reads BW-CB-55120",
    match: /BM-CB-55120/,
  },
  {
    id: "d2-lens-mug",
    clipId: "d2-rma-20419-complete",
    itemKey: "lens",
    by: ["open-weight auditor (Baseten)"],
    said: "clearly legible on the lens, no stand-in",
    loss: "missed: the lens prop is a camera-lens-shaped mug; the stand-in check passed it",
    match: /legible on the lens/i,
  },
];

/**
 * Fleet answers that are false and are never shown or sent (withheld from every replay), matched by the provider's
 * request id so only that recorded answer is withheld. The fleet's box then stays on app code for that role, and the
 * page says one answer was withheld and why.
 */
export const WITHHELD_FLEET_ANSWERS: Array<{ rmaId: string; role: string; requestId: string; why: string }> = [
  {
    rmaId: "RMA-20418",
    role: "customer-message-drafter",
    requestId: "chatcmpl-01a1a26a-f2af-7550-821c-913e0a67df79",
    why: "its customer message called the real camera a toy and said the camera body wasn't seen: false, so it is never shown or sent (a loss)",
  },
  {
    rmaId: "RMA-20419",
    role: "customer-message-drafter",
    requestId: "chatcmpl-01a1a26e-14a6-75e4-b159-bacaf7039ea9",
    why: "its customer message said the camera body couldn't be confirmed, from the label reader's BM-CB-55120 misread on a complete kit, so it is never shown or sent (a loss)",
  },
];

/** What a specific A/B run lost that its report doesn't record per row (shown beside the arm note). */
export const AB_RUN_NOTES: Record<string, string> = {
  "ab_1": "an answer can still be lost: Glimmer timed out on d2",
};

/** A clip by its full id ("d2-rma-20419-complete") or the short id the A/B and gate rows use ("d2"). */
const sameClip = (m: KnownMisread, clipId: string | undefined) => !!clipId && (m.clipId === clipId || m.clipId.startsWith(`${clipId}-`));
export const misreadsFor = (clipId: string | undefined, itemKey?: string) => KNOWN_MISREADS.filter((m) => sameClip(m, clipId) && (!itemKey || m.itemKey === itemKey));

/** The misreads whose words appear in this text (a reason, a reader note, a draft) for this clip. */
export const misreadsIn = (clipId: string | undefined, text: string, itemKey?: string) => misreadsFor(clipId, itemKey).filter((m) => m.match.test(text));
