import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SessionNav } from "@/components/session-nav";

import "./globals.css";

export const metadata: Metadata = {
  title: "Dasher",
  description:
    "Upload a spreadsheet, say what you want to see, get an evidence-backed dashboard.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <a className="site-header-home" href="/">
            Dasher
          </a>
          <nav className="site-header-nav" aria-label="Site">
            <a href="/dashboards">Dashboards</a>
            <SessionNav />
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
