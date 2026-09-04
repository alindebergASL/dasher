# Dasher

**Upload a spreadsheet. Say what you want to see. Get a dashboard you can
trust, in under a minute. Change it by asking.**

## Who it is for

Managers and leaders who have the numbers in a file and no time to build a
report. They should never have to define a KPI, pick a chart, or reshape a
column to get a useful first view.

## The loop

1. **Upload** a CSV export of anything tabular: transactions, a budget by
   month, a pipeline, a headcount list. Dasher reads the columns and shows how
   it read them.
2. **Ask** in plain language what the dashboard should show. A planning model
   chooses which column is the figure, which is the grouping, which is the
   date, and how the pages are laid out. It never sees a total.
3. **Compute.** Trusted code calculates every number with exact decimal
   arithmetic. Every figure on the page cites the file it came from and the
   arithmetic that produced it. There is nothing on the page a model wrote a
   number into.
4. **Read** the 30-second brief: what is known, what changed, what deserves
   attention, and one next action. Then the pages: totals, by category,
   movers, trend, largest rows, budget variance, the rows themselves.
5. **Change it by asking.** "Exclude salaries." "Quarterly." "Just the
   overview." The model edits the plan; the numbers are recomputed.
6. **Keep it.** Saved dashboards are private to your organization, listed,
   shareable with colleagues in that organization, and archivable.

## What makes it different

- **The model decides composition; code decides facts.** This is the whole
  architecture. It is why a dashboard from Dasher can be trusted with a
  number, and why refinement is safe.
- **Evidence is one click away.** Every claim opens to the file, the rows,
  and the calculation behind it.
- **It reads your file, not a template.** Header mapping, tolerant number
  and date parsing, wide-to-long unpivoting. A real export should work on the
  first try.

## Not now

Live connectors, scheduling and refresh, XLSX, Google Sheets, public sharing,
alerts, billing. Each returns as a table through the same pipeline when a
pilot user asks for it.

## How we work

One person uploads a real spreadsheet every week with the model on. If the
dashboard is not one they would keep, that is next week's work. Every change
either changes something on a screen or deletes something. Read
[STATUS.md](STATUS.md) for what works today.
