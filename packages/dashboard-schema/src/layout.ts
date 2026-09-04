import type { DashboardComponent } from "./schema";

/**
 * Packing v1.
 *
 * The grid was three columns and every component hardcoded its own width in
 * renderer JSX. Five of the seven kinds asked for the full width, so a page
 * read as a stack of bands with whatever was left over stranded in the last
 * row: a ranking alone in one of three columns, a short card floating above a
 * hole beside a taller map. Neither was a decision anybody made — they were
 * the residue of seven independent choices that never saw each other.
 *
 * So the widths move here, where they can be reasoned about together, and a
 * packer turns a sequence of kinds into a set of full rows. It is a function
 * of the kind sequence and nothing else: no measurement, no content, no
 * randomness. The same dashboard packs the same way every time.
 */

export type DashboardComponentKind = DashboardComponent["kind"];

/**
 * Six, not three. Three cannot express halves, so a map beside a ranking had
 * to be 2 + 1 — lopsided for two peers. Six divides into thirds and halves
 * alike, which is the whole vocabulary this slice needs.
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
 * share a row (`LAYOUT_COLUMNS / minSpan`). A map at one sixth is a smudge and
 * at one third it was 347px — too small to place a marker in — so it claims a
 * half. A ranking is a short list of names and reads fine in a third.
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
