import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Suspense } from "react";
import { Nav, NavFallback } from "@/components/Nav";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: { default: "ReturnWitness: the refund waits for what's in the box", template: "%s · ReturnWitness" },
  description:
    "For returns teams at stores that ship multi-item kits: an overhead camera films the unboxing, app code counts what came back against the packing slip, and the refund is held until a person approves.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0E0E0E" },
    { media: "(prefers-color-scheme: light)", color: "#E6E4DE" },
  ],
};

// Dark is the default. Runs before first paint so there is no flash of the wrong theme.
const themeBoot = `try{var t=localStorage.getItem("rw-theme");document.documentElement.dataset.theme=(t==="light"||t==="dark")?t:"dark";}catch(e){document.documentElement.dataset.theme="dark";}`;
// Film mode (localStorage rw-film = "1", set by the capture script): no wall-clock time on screen; durations stay.
const filmBoot = `try{if(localStorage.getItem("rw-film")==="1")document.documentElement.dataset.film="1";}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot + filmBoot }} />
      </head>
      <body>
        <a href="#main" className="sr-only">
          Skip to content
        </a>
        <Suspense fallback={<NavFallback />}>
          <Nav />
        </Suspense>
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
