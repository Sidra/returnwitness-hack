import type { Metadata } from "next";
import { PlayView } from "@/components/play/PlayView";

export const metadata: Metadata = {
  title: "Check a walker back in",
  description:
    "Runs in your browser: app code, no model. An illustration of the same rules in a second setting: a folding walker back at a mobility-equipment loan closet. Count each part into the tray; anything missing keeps it off the shelf until a volunteer signs it off. Parts present only, never a safety judgement.",
};

export default function PlayWalkerPage() {
  return <PlayView id="walker" />;
}
