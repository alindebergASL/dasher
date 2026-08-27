import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SessionNav } from "@/components/session-nav";

import "./globals.css";

export const metadata: Metadata = {
  title: "Dasher · River Conditions",
  description:
    "Evidence-backed dashboards created from a plain-language request.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        {/*
         * The only chrome in the product, and it comes AFTER the content in the
         * DOM on purpose.
         *
         * The rule it has to respect is the one the pinned request bar exists
         * for: the executive brief must fit inside the first mobile viewport at
         * 390x844. Measured, a top bar with a touch target anyone could hit
         * costs about 33px and the budget had 20 — so a header above the
         * content is not something this page can afford on a phone, and
         * shrinking it to fit would have meant an 11px tap target.
         *
         * So on a phone it sits at the bottom, where it costs the first
         * viewport nothing, and on a wider screen `order: -1` lifts it to the
         * top where there is room. Content-first DOM order is the right way
         * round for a screen reader regardless; the desktop arrangement is the
         * exception being made, not the rule.
         */}
        <header className="site-header">
          <a className="site-header-home" href="/">
            Dasher
          </a>
          <nav className="site-header-nav" aria-label="Site">
            <a href="/dashboards">Dashboards</a>
            <SessionNav />
          </nav>
        </header>
      </body>
    </html>
  );
}
