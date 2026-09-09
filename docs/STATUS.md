# Status

Updated: 2026-09-09. This file replaces the previous document corpus. It says
what works, what does not, and what is next. Keep it under a page.

Dasher is a harness that builds a dashboard from a tabular file and a sentence
about what you want to know. It is not a finance tool. The kind of thing being
measured — money, hours, tickets, readings, signups — is the file's business,
not the product's, and a rule that only works for one of them is a bug.

## What works

- **Upload a CSV, get a dashboard.** Comma, semicolon, or tab separated;
  currency symbols, thousands separators, parenthesised negatives, blanks;
  ISO, US and European conventions decided per column; wide exports (one column
  per period) are unpivoted. Up to 4 MB.
- **Any numeric column can be the measure.** Identifiers, codes, ordinals and
  periods are claimed by their own rules first; what survives them is a
  quantity, whatever it counts. There is no list of subjects Dasher will
  measure.
- **A planner chooses how to read the file and lay out the pages.** The
  built-in deterministic planner is the default and what CI runs. Select
  `anthropic` or `openrouter` with its named key to have a model plan instead.
  Either way the plan names column roles, filters, grain, and sections. It
  never carries a figure.
- **Every number is computed by trusted code** with exact decimals, and every
  component cites the source file and the calculation. The 30-second brief
  (known, changed, important, next action), totals, by category, movers,
  trend, largest rows, budget variance, relationships between two measures,
  mixed-sign flows, and the rows themselves.
- **Comparisons are withheld when they would mislead, and only then.** A period
  is complete when its observations fill a regular frequency, or — for data
  that arrives on no fixed schedule, which is most data — when the period had
  ended before the source was retrieved. A period the file was taken inside is
  reported as partial, with the days elapsed.
- **Change it by asking.** Exclude a category, switch to quarterly, keep the
  last N periods, drop or add a section, shorten to one page. The browser
  re-sends the file; the server keeps nothing between requests.
- **Sign in by emailed link; save, list, reopen, archive.** Dashboards are
  private to an organization and shared within it. Uploaded bytes are stored
  as immutable evidence beside the version that cites them.
- **Deployed** to one instance with Docker Compose, Caddy TLS, and off-box
  backups (`deploy/`), and running against real files.

## Known gaps

- A saved dashboard reopens read-only; it cannot yet be refined from its page.
  Doing so needs a new migration to store the plan beside the version.
- Evidence is per dashboard, not per claim: every figure cites the same two
  records (the file, and how the figures were computed). Row-level evidence is
  the next thing the evidence chain needs.
- XLSX is not read; export to CSV first.
- Two periods with a gap between them are reported as unknown rather than
  compared as the two periods they are.
- No search across saved dashboards; the list is most-recent-first, 50 deep.
- The model planner has no spend accounting beyond a per-day call cap.
- The sign-in throttle is per server process.
- Legal review of terms for a pilot user beyond the owner has not happened.

## Standing constraints

- **Migrations 0001–0005 are frozen.** The deployment holds real data, so
  `DECISIONS.md` item 6 now binds: schema changes are forward-only, by a new
  migration, never by editing an applied one.
- **`fixtures/adversarial/` grows with every defect that reached a screen.**
  `apps/web/test/pipeline-oracle.test.ts` is the only suite whose expected
  values are computed outside the code under test. A fix without a case there
  is not finished.

## Next

1. Put a real spreadsheet through it with the model on, every week, and fix
   what that shows.
2. Refine from a saved dashboard's page (the file is already stored).
3. XLSX intake through the same `Table`.
4. Invite a second member to the owner's organization
   (`provision --organization <id>`) and use it together.
