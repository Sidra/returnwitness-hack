"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Phase = "idle" | "requesting" | "live" | "error";
interface Cam { id: string; label: string }

function describeError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Camera permission was denied. Allow camera access for this site in the browser settings, then press the button again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera was found. Plug in a camera, or unlock the iPhone near the Mac so Continuity Camera can appear, then try again.";
    case "NotReadableError":
    case "TrackStartError":
      return "The camera is in use by another app or could not be started. Close the other app and try again.";
    case "OverconstrainedError":
      return "That camera is no longer available. Pick another one from the list.";
    case "SecurityError":
      return "The browser blocked camera access. Camera access needs a secure page (https or localhost).";
    default:
      return "The camera could not be opened. Check the connection and try again.";
  }
}

/** Lists video inputs, previews the chosen one and overlays the BOX / TRAY zones. No device name is hardcoded. */
export function CameraTest() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [cams, setCams] = useState<Cam[]>([]);
  const [selected, setSelected] = useState("");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const refreshDevices = useCallback(async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    setCams(
      all
        .filter((d) => d.kind === "videoinput")
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` })),
    );
  }, []);

  const open = useCallback(
    async (deviceId?: string) => {
      if (typeof window === "undefined" || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setPhase("error");
        setMessage("Camera access needs a secure page (https or localhost) in a browser that supports it. Open this page from localhost or the deployed https address.");
        return;
      }
      setPhase("requesting");
      setMessage(null);
      stopStream();
      setStream(null);
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: deviceId ? { deviceId: { exact: deviceId } } : true,
          audio: false,
        });
        streamRef.current = s;
        setStream(s);
        setSelected(s.getVideoTracks()[0]?.getSettings().deviceId ?? deviceId ?? "");
        await refreshDevices(); // labels are only populated after permission is granted
        setPhase("live");
      } catch (e) {
        setPhase("error");
        setMessage(describeError(e));
      }
    },
    [refreshDevices, stopStream],
  );

  // Attach the stream to the <video>; no state is set here.
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.srcObject = stream;
  }, [stream]);

  // Keep the list fresh when a camera is plugged in or the iPhone appears; stop the stream on unmount.
  useEffect(() => {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    const onChange = () => {
      if (streamRef.current) void refreshDevices();
    };
    md?.addEventListener?.("devicechange", onChange);
    return () => {
      md?.removeEventListener?.("devicechange", onChange);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [refreshDevices]);

  const zoneLabel = { position: "absolute" as const, top: 8, padding: "2px 8px", background: "var(--card)", color: "var(--ink)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, letterSpacing: ".06em" };

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={() => void open(selected || undefined)} disabled={phase === "requesting"}>
          {phase === "live" ? "Restart camera" : phase === "requesting" ? "Waiting for permission…" : "Test camera"}
        </button>
        {phase === "live" && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              stopStream();
              setStream(null);
              setPhase("idle");
            }}
          >
            Stop
          </button>
        )}
      </div>

      {cams.length > 0 && (
        <label className="field">
          Video input
          <select className="select" value={selected} onChange={(e) => { setSelected(e.target.value); void open(e.target.value); }}>
            {cams.map((c) => (
              <option key={c.id || c.label} value={c.id}>{c.label}</option>
            ))}
          </select>
        </label>
      )}

      {message && (
        <p role="alert" className="well" style={{ margin: 0, borderLeft: "5px solid var(--accent)" }}>{message}</p>
      )}

      <div className="viewport" aria-label="Camera preview with BOX and TRAY zones">
        <video ref={videoRef} autoPlay muted playsInline />
        {phase !== "live" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, textAlign: "center" }} className="muted">
            Press &ldquo;Test camera&rdquo; to preview. Nothing is recorded or uploaded.
          </div>
        )}
        <div aria-hidden style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "45%", border: "3px dashed var(--accent)" }}>
          <span style={{ ...zoneLabel, left: 8 }}>BOX · left 45%</span>
        </div>
        <div aria-hidden style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: "45%", border: "3px solid var(--accent)" }}>
          <span style={{ ...zoneLabel, right: 8 }}>TRAY · right 45%</span>
        </div>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        Line the tape up with the two frames. The preview stays in this browser tab; it is not recorded or uploaded.
      </p>
    </div>
  );
}
