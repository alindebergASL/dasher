import type { DashboardComponent } from "./schema";

/**
 * Component widths, decided together.
 *
 * Every kind declares how narrow it can go, and the packer turns a sequence
 * of kinds into a set of exactly full rows. It is a function of the kind
 * sequence and nothing else: no measurement, no content, no randomness. The
 * same dashboard packs the same way every time, and a page never ends in a
 * ragged row with one component stranded beside a hole.
 */

export type DashboardComponentKind = DashboardComponent["kind"];

/**
 * Six divides into halves and thirds alike, which is the whole vocabulary the
 * constraints below need; three cannot express two equal peers on one row.
 */
export const LAYOUT_COLUMNS = 6;

export interface LayoutConstraint {
  /** The narrowest this kind stays legible at. */
  readonly minSpan: number;
  /** The widest it is allowed to grow to when a row needs filling. */
  readonly maxSpan: number;
}

/**
 * `minSpan` is the load-bearing number: it decides how many of a kind can
 * share a row (`LAYOUT_COLUMNS / minSpan`). A table has as many columns as the
 * spreadsheet gave it, so it always takes the full row; a trend card needs
 * room for its sparkline and claims a half; a ranking or alert list is a short
 * list of names and reads fine in a third.
 */
export const COMPONENT_LAYOUT: Readonly<
  Record<DashboardComponentKind, LayoutConstraint>
> = {
  summary: { minSpan: 6, maxSpan: 6 },
  "metric-grid": { minSpan: 6, maxSpan: 6 },
  table: { minSpan: 6, maxSpan: 6 },
  ranking: { minSpan: 2, maxSpan: 6 },
  "trend-list": { minSpan: 3, maxSpan: 6 },
  "alert-list": { minSpan: 2, maxSpan: 6 },
};

export interface PlacedComponent<TComponent> {
  readonly component: TComponent;
  /** Columns out of `LAYOUT_COLUMNS`. */
  readonly span: number;
  /** Zero-based row index, so a caller can group without re-deriving it. */
  readonly row: number;
}

interface Packable {
  readonly kind: DashboardComponentKind;
}

/**
 * How many of these can share one row. A full-width kind answers 1, which is
 * what keeps it from being packed beside anything.
 */
function perRowLimit(items: readonly Packable[]): number {
  return items.reduce((limit, item) => {
    const { minSpan } = COMPONENT_LAYOUT[item.kind];
    return Math.min(limit, Math.floor(LAYOUT_COLUMNS / minSpan));
  }, LAYOUT_COLUMNS);
}

/** Whether this kind is narrow enough to have company on its row. */
function sharesRows(item: Packable): boolean {
  return perRowLimit([item]) > 1;
}

/**
 * Maximal stretches of components that can share rows with each other. A
 * full-width kind is a run of one, and it does not take its neighbours with
 * it: two rankings either side of a summary still pair up on their own rows,
 * where letting them all into one run would stack all four full-width.
 */
function runsOf<TComponent extends Packable>(
  components: readonly TComponent[],
): TComponent[][] {
  const runs: TComponent[][] = [];
  for (const component of components) {
    const current = runs.at(-1);
    if (current && sharesRows(component) && sharesRows(current[0]!)) {
      current.push(component);
    } else {
      runs.push([component]);
    }
  }
  return runs;
}

/**
 * Split `total` items into `rows` groups as evenly as possible, the larger
 * groups first. Five flexible components become 3 + 2; four become 2 + 2
 * rather than 3 + 1. Greedy filling gets the first rows right and leaves the
 * remainder in the last one, which is the ragged tail this slice removes.
 */
function groupSizes(total: number, rows: number): number[] {
  const base = Math.floor(total / rows);
  const remainder = total % rows;
  return Array.from({ length: rows }, (_, index) =>
    index < remainder ? base + 1 : base,
  );
}

/**
 * Assign each component a width so that every row is exactly full.
 *
 * Order is preserved exactly: this decides how wide things are, never what
 * comes first. Plan order is the reading order somebody chose.
 */
export function packComponents<TComponent extends Packable>(
  components: readonly TComponent[],
): PlacedComponent<TComponent>[] {
  const placed: PlacedComponent<TComponent>[] = [];
  let row = 0;
  for (const run of runsOf(components)) {
    const rows = Math.ceil(run.length / perRowLimit(run));
    let offset = 0;
    for (const size of groupSizes(run.length, rows)) {
      for (const component of run.slice(offset, offset + size)) {
        placed.push({ component, span: LAYOUT_COLUMNS / size, row });
      }
      offset += size;
      row += 1;
    }
  }
  return placed;
}
