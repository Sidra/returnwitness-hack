export const formatCents = (c: number): string => {
  const sign = c < 0 ? "-" : "";
  const v = Math.abs(Math.round(c));
  const dollars = Math.floor(v / 100).toLocaleString("en-US");
  const cents = String(v % 100).padStart(2, "0");
  return cents === "00" ? `${sign}$${dollars}` : `${sign}$${dollars}.${cents}`;
};

/** Always two decimals, for receipts and ledgers. */
export const formatCentsExact = (c: number): string => {
  const sign = c < 0 ? "-" : "";
  const v = Math.abs(Math.round(c));
  return `${sign}$${Math.floor(v / 100).toLocaleString("en-US")}.${String(v % 100).padStart(2, "0")}`;
};

export const formatSeconds = (s: number): string => `${s.toFixed(1)} s`;

export const formatClipTime = (t: number): string => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};
