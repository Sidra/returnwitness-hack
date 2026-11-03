"use client";

/**
 * The bench camera: lists video inputs (an iPhone shows up through Continuity Camera), never by
 * hardcoded name; previews it with the BOX / TRAY zones drawn on top; records a clip (video
 * only). Every failure (no camera, permission denied, insecure context) gets a plain message.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Dev = { deviceId: string; label: string };

export function CameraPicker({ clipName, onRecorded }: { clipName: string; onRecorded?: (blob: Blob) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [devices, setDevices] = useState<Dev[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [status, setStatus] = useState<string>("Camera off");
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [res, setRes] = useState<string>("");
  const [live, setLive] = useState(false);
  const [mime, setMime] = useState("");

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setLive(false);
  }, []);

  useEffect(() => () => stop(), [stop]);
  useEffect(() => () => {
    if (clipUrl) URL.revokeObjectURL(clipUrl);
  }, [clipUrl]);

  const list = useCallback(async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    const vids = all.filter((d) => d.kind === "videoinput").map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
    setDevices(vids);
    return vids;
  }, []);

  const start = useCallback(
    async (id?: string) => {
      setError(null);
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setError("The camera needs a secure page (https or localhost) and a browser that allows camera access.");
        return;
      }
      try {
        stop();
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { ...(id ? { deviceId: { exact: id } } : {}), width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        const track = stream.getVideoTracks()[0];
        const s = track.getSettings();
        setRes(s.width && s.height ? `${s.width}×${s.height}${s.frameRate ? ` @ ${Math.round(s.frameRate)} fps` : ""}` : "");
        const vids = await list();
        const active = s.deviceId ?? id ?? vids[0]?.deviceId ?? "";
        setDeviceId(active);
        setStatus(`Live: ${track.label || "camera"}`);
        setLive(true);
      } catch (e) {
        const name = e instanceof DOMException ? e.name : "";
        setError(
          name === "NotAllowedError"
            ? "Camera permission was denied. Allow camera access for this site in the browser settings, then try again."
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "No camera found. If you're using an iPhone, unlock it, keep it near the Mac with Wi-Fi and Bluetooth on, and pick it from the list."
              : `The camera couldn't start: ${e instanceof Error ? e.message : String(e)}`,
        );
        setStatus("Camera off");
      }
    },
    [list, stop],
  );

  const record = () => {
    const stream = streamRef.current;
    if (!stream) return;
    const type = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    try {
      const rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 12_000_000 } : undefined);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = () => {
        const blob = new Blob(chunks.current, { type: rec.mimeType || "video/webm" });
        setClipUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(blob);
        });
        setMime(rec.mimeType);
        onRecorded?.(blob);
        setRecording(false);
      };
      rec.start(500);
      recRef.current = rec;
      setRecording(true);
    } catch (e) {
      setError(`Recording isn't supported here: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const ext = mime.includes("mp4") ? "mp4" : "webm";

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="viewport">
        <video ref={videoRef} muted playsInline aria-label="Live bench camera" />
        <svg viewBox="0 0 100 56.25" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} aria-hidden>
          <rect x="1" y="1" width="43" height="54.25" fill="none" stroke="currentColor" strokeDasharray="1.5 1.2" strokeWidth="0.4" />
          <rect x="56" y="1" width="43" height="54.25" fill="none" stroke="currentColor" strokeDasharray="1.5 1.2" strokeWidth="0.4" />
        </svg>
        <span className="viewport-label mode">{status}</span>
        {!live && !error && (
          <p className="muted" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", margin: 0, padding: 16, textAlign: "center" }}>
            BOX on the left, INSPECTED TRAY on the right. Start the camera to line them up.
          </p>
        )}
      </div>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="field" style={{ flex: "1 1 240px" }}>
          Camera
          <select
            className="select"
            value={deviceId}
            onChange={(e) => {
              setDeviceId(e.target.value);
              start(e.target.value);
            }}
          >
            {devices.length === 0 && <option value="">Start the camera to list devices</option>}
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-sm" onClick={() => start(deviceId || undefined)}>
          {live ? "Restart camera" : "Start camera"}
        </button>
        {live && !recording && (
          <button type="button" className="btn btn-sm btn-accent" onClick={record}>
            Record clip
          </button>
        )}
        {recording && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => recRef.current?.stop()}>
            Stop recording
          </button>
        )}
      </div>
      {res && <span className="mono muted" style={{ fontSize: 12 }}>{res} · iPhone via Continuity Camera: turn off Center Stage, Portrait, Studio Light and Desk View</span>}
      {clipUrl && (
        <div className="row">
          <a className="btn btn-sm" href={clipUrl} download={`${clipName}.${ext}`}>
            Save {clipName}.{ext}
          </a>
          <span className="muted" style={{ fontSize: 14 }}>Clip saved in this browser only. Nothing was uploaded.</span>
        </div>
      )}
      {error && (
        <p role="alert" style={{ margin: 0, color: "var(--danger)", fontWeight: 600 }}>
          {error}
        </p>
      )}
    </div>
  );
}
