import type { Metadata } from "next";
import { Inter, Fraunces, Geist_Mono, Newsreader } from "next/font/google";
import "./globals.css";

// Four voices, four jobs: Fraunces = display headlines, Inter = UI/body, Geist Mono = data/labels/timestamps,
// Newsreader (italic) = the spoken advisory line — the words the rep actually says, set apart from the machine's chrome.
const sans = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
const serif = Fraunces({ variable: "--font-fraunces", subsets: ["latin"], display: "swap", style: ["normal", "italic"] });
const mono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"], display: "swap" });
const read = Newsreader({ variable: "--font-read", subsets: ["latin"], display: "swap", weight: ["400", "500"], style: ["normal", "italic"] });

export const metadata: Metadata = {
  title: "PRUAssist — Advisor Co-Pilot",
  description:
    "A private AI co-pilot for Prudential financial representatives during live advisory sessions. It listens, detects confusion, and surfaces policy-grounded talking points — privately.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable} ${read.variable}`}>
      {/* suppressHydrationWarning: browser extensions (e.g. Grammarly) inject data-* attributes
          onto <body> before React hydrates, which would otherwise log a hydration mismatch. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
