# Status

Updated: 2026-09-04. This file replaces the previous document corpus. It says
what works, what does not, and what is next. Keep it under a page.

## What works

- **Upload a CSV, get a dashboard.** Comma, semicolon, or tab separated;
  currency symbols, thousands separators, parenthesised negatives, blanks;
  ISO and US dates; wide budget exports (one column per month) are unpivoted.
  Up to 4 MB.
- **A planner chooses how to read the file and lay out the pages.** The
  built-in deterministic planner is the default and what CI runs. Set
  `DASHER_PLANNER=anthropic` with a key to have a model plan instead. Either
  way the plan names column roles, filters, grain, and sections. It never
  carries a figure.
- **Every number is computed by trusted code** with exact decimals, and every
  component cites the source file and the calculation. The 30-second brief
  (known, changed, important, next action), totals, by category, movers,
  trend, largest rows, budget variance, and the rows themselves.
- **Change it by asking.** Exclude a category, switch to quarterly, keep the
  last N periods, drop or add a section, shorten to one page. The browser
  re-sends the file; the server keeps nothing between requests.
- **Sign in by emailed link; save, list, reopen, archive.** Dashboards are
  private to an organization and shared within it. Uploaded bytes are stored
  as immutable evidence beside the version that cites them.
- **Deploy** to one instance with Docker Compose, Caddy TLS, and off-box
  backups (`deploy/`).

## Known gaps

- A saved dashboard reopens read-only; it cannot yet be refined from its page.
- Evidence is per dashboard, not per claim: every figure cites the same two
  records (the file, and how the figures were computed). Row-level evidence is
  the next thing the evidence chain needs.
- XLSX is not read; export to CSV first.
- No search across saved dashboards; the list is most-recent-first, 50 deep.
- The model planner has no spend accounting beyond a per-day call cap.
- The sign-in throttle is per server process.
- Legal review of terms for a pilot user beyond the owner has not happened.

## Next

1. Put a real spreadsheet through it with the model on, every week, and fix
   what that shows.
2. Refine from a saved dashboard's page (the file is already stored).
3. XLSX intake through the same `Table`.
4. Invite a second member to the owner's organization
   (`provision --organization <id>`) and use it together.
