# Status

Updated: 2026-09-09. This file replaces the previous document corpus. It says
what works, what does not, and what is next. Keep it under a page.

Dasher is a harness that builds a dashboard from a tabular file and a sentence
about what you want to know. It is not a finance tool. The kind of thing being
measured — money, hours, tickets, readings, signups — is the file's business,
not the product's, and a rule that only works for one of them is a bug.

## What works

- **Upload a spreadsheet or a CSV, get a dashboard.** `.xlsx` is read directly:
  the first sheet holding a header and rows, past any cover sheet, with date
  serials resolved and amounts carried as the characters the file stores. The
  reader is this repository's own — a spreadsheet is a zip of XML and Node can
  already inflate one — so the package still has no runtime dependencies.
- **Upload a CSV, get a dashboard.** Comma, semicolon, or tab separated;
  currency symbols, thousands separators, parenthesised negatives, blanks;
  ISO, US and European conventions decided per column; wide exports (one column
  per period) are unpivoted. Up to 4 MB.
- **The analysis bucket follows the file.** Day, week, month, quarter and year,
  chosen from how much time the data covers: eight months of transactions are
  monthly, six weeks of daily readings are weekly, a fortnight of them is
  daily. A column whose cells state their own period ("2026-01", "Q1 2026")
  is never cut finer than it says. Ask for "weekly" or "by day" to override.
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
  reported as partial, with the days elapsed, and the trend still plots every
  period that is complete.
- **Change a saved dashboard by asking, from its own page.** The file is kept
  as an immutable snapshot and the reading behind it beside the version, so a
  change recomputes from the same bytes and writes a successor version at the
  same link. Nothing is edited in place — the version approved yesterday is
  still exactly what it was. A dashboard saved before the reading was kept
  opens and says why it cannot be changed.
- **Change it by asking.** Exclude a category, switch to quarterly, keep the
  last N periods, drop or add a section, shorten to one page. The browser
  re-sends the file; the server keeps nothing between requests.
- **Sign in by emailed link; save, list, reopen, archive.** Dashboards are
  private to an organization and shared within it. Uploaded bytes are stored
  as immutable evidence beside the version that cites them.
- **Deployed** to one instance with Docker Compose, Caddy TLS, and off-box
  backups (`deploy/`), and running against real files.

## Known gaps

- Evidence is per dashboard, not per claim: every figure cites the same two
  records (the file, and how the figures were computed). Row-level evidence is
  the next thing the evidence chain needs.
- A spreadsheet's formulas are read at their last calculated value; one never
  calculated is blank. Charts, pivot tables and macros are ignored.
- Two periods with a gap between them are reported as unknown rather than
  compared as the two periods they are.
- A file starting mid-period gives a short first bucket that is plotted as if
  it were whole. The trailing edge is handled — a period the export was taken
  inside is withheld — but at the leading edge there is no way to tell data
  that is missing from data that did not exist yet, so nothing is claimed.
- No search across saved dashboards; the list is most-recent-first, 50 deep.
- The model planner has no spend accounting beyond a per-day call cap.
- The sign-in throttle is per server process.
- Legal review of terms for a pilot user beyond the owner has not happened.

## Standing constraints

- **Migrations 0001–0006 are frozen.** The deployment holds real data, so
  `DECISIONS.md` item 6 now binds: schema changes are forward-only, by a new
  migration, never by editing an applied one. `audit_events_action_check` is an
  allowlist a CHECK cannot extend in place, so a migration adding an action
  restates the whole list — copy it from the migration that last stated it, not
  from the baseline, or a name added in between is silently dropped.
  `audit-actions.test.ts` fails when that happens.
- **`fixtures/adversarial/` grows with every defect that reached a screen.**
  `apps/web/test/pipeline-oracle.test.ts` is the only suite whose expected
  values are computed outside the code under test. A fix without a case there
  is not finished.

## Next

1. Put a real spreadsheet through it with the model on, every week, and fix
   what that shows.
2. Row-level evidence, so a figure cites the rows behind it rather than the
   file as a whole.
3. Invite a second member to the owner's organization
   (`provision --organization <id>`) and use it together.
