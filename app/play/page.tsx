import type { Metadata } from "next";
import { PlayView } from "@/components/play/PlayView";

export const metadata: Metadata = {
  title: "Return a box yourself",
  description:
    "Runs in your browser: app code, no model. Move a returned camera kit from the box into the inspected tray and watch the same app-code rules the bench uses decide what a person may approve. No camera, no paid call.",
};

export default function PlayPage() {
  return <PlayView id="camera" />;
}
