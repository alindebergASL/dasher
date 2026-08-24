import { describe, expect, it } from "vitest";

import {
  COMPONENT_LAYOUT,
  LAYOUT_COLUMNS,
  packComponents,
  type DashboardComponentKind,
} from "./layout";

const KINDS = Object.keys(COMPONENT_LAYOUT) as DashboardComponentKind[];

function seq(...kinds: DashboardComponentKind[]) {
  return kinds.map((kind, index) => ({ kind, id: `${kind}:${index}` }));
}

/** Every sequence of kinds of exactly `length`. */
function* exactly(length: number): Generator<DashboardComponentKind[]> {
  if (length === 0) {
    yield [];
    return;
  }
  for (const rest of exactly(length - 1)) {
    for (const kind of KINDS) {
      yield [...rest, kind];
    }
  }
}

/** Every sequence of kinds up to `length`, shortest first. */
function* sequences(length: number): Generator<DashboardComponentKind[]> {
  for (let size = 0; size <= length; size += 1) {
    yield* exactly(size);
  }
}

function rowsOf<T>(placed: Array<{ span: number; row: number; component: T }>) {
  const rows = new Map<number, Array<{ span: number; component: T }>>();
  for (const entry of placed) {
    const row = rows.get(entry.row) ?? [];
    row.push(entry);
    rows.set(entry.row, row);
  }
  return rows;
}

describe("packComponents invariants", () => {
  const all = [...sequences(4)];

  it("covers every sequence of four kinds", () => {
    // Guards the generator itself: if it silently produced nothing, every
    // invariant below would pass vacuously.
    expect(all).toHaveLength(1 + 7 + 7 ** 2 + 7 ** 3 + 7 ** 4);
  });

  it("preserves input order and places each component exactly once", () => {
    for (const kinds of all) {
      const input = seq(...kinds);
      const placed = packComponents(input);
      expect(placed.map((entry) => entry.component)).toEqual(input);
    }
  });

  it("fills every row exactly", () => {
    for (const kinds of all) {
      const placed = packComponents(seq(...kinds));
      for (const [, row] of rowsOf(placed)) {
        expect(row.reduce((sum, entry) => sum + entry.span, 0)).toBe(
          LAYOUT_COLUMNS,
        );
      }
    }
  });

  it("keeps every span inside its kind's constraint", () => {
    for (const kinds of all) {
      const placed = packComponents(seq(...kinds));
      for (const entry of placed) {
        const constraint = COMPONENT_LAYOUT[entry.component.kind];
        expect(entry.span).toBeGreaterThanOrEqual(constraint.minSpan);
        expect(entry.span).toBeLessThanOrEqual(constraint.maxSpan);
      }
    }
  });

  it("numbers rows consecutively from zero and never splits a row", () => {
    for (const kinds of all) {
      const placed = packComponents(seq(...kinds));
      const rows = placed.map((entry) => entry.row);
      let expected = 0;
      for (const [index, row] of rows.entries()) {
        if (index > 0 && row !== rows[index - 1]) expected += 1;
        expect(row).toBe(expected);
      }
      expect(new Set(rows).size).toBe(placed.length === 0 ? 0 : expected + 1);
    }
  });

  it("is a function of the kind sequence alone", () => {
    for (const kinds of all) {
      const once = packComponents(seq(...kinds)).map((entry) => entry.span);
      const twice = packComponents(seq(...kinds)).map((entry) => entry.span);
      expect(twice).toEqual(once);
    }
  });
});

describe("packComponents balance", () => {
  it("gives a lone flexible component the full width", () => {
    expect(packComponents(seq("ranking")).map((entry) => entry.span)).toEqual([
      LAYOUT_COLUMNS,
    ]);
  });

  it("splits a map and a ranking into equal halves on one row", () => {
    expect(packComponents(seq("station-map", "ranking"))).toEqual([
      {
        component: { kind: "station-map", id: "station-map:0" },
        span: 3,
        row: 0,
      },
      { component: { kind: "ranking", id: "ranking:1" }, span: 3, row: 0 },
    ]);
  });

  it("balances four thirds-wide components as 2 + 2, not 3 + 1", () => {
    const placed = packComponents(
      seq("ranking", "alert-list", "ranking", "alert-list"),
    );
    expect(placed.map((entry) => entry.row)).toEqual([0, 0, 1, 1]);
    expect(placed.map((entry) => entry.span)).toEqual([3, 3, 3, 3]);
  });

  it("balances five thirds-wide components as 3 + 2", () => {
    const placed = packComponents(
      seq("ranking", "ranking", "ranking", "ranking", "ranking"),
    );
    expect(placed.map((entry) => entry.row)).toEqual([0, 0, 0, 1, 1]);
    expect(placed.map((entry) => entry.span)).toEqual([2, 2, 2, 3, 3]);
  });

  it("lets a half-width kind hold a run to two per row", () => {
    // The map's minSpan is the binding constraint for the whole run: without
    // it these three would sit three-across at a third each.
    const placed = packComponents(seq("station-map", "ranking", "alert-list"));
    expect(placed.map((entry) => entry.row)).toEqual([0, 0, 1]);
    expect(placed.map((entry) => entry.span)).toEqual([3, 3, 6]);
  });

  it("gives a full-width kind its own row", () => {
    const placed = packComponents(
      seq("ranking", "metric-grid", "alert-list", "summary"),
    );
    expect(placed.map((entry) => entry.row)).toEqual([0, 1, 2, 3]);
    expect(placed.map((entry) => entry.span)).toEqual([6, 6, 6, 6]);
  });

  it("does not let a full-width kind drag its neighbours to full width", () => {
    // The case above cannot show this: no two of its flexible components are
    // adjacent, so nothing is there to be absorbed. Here the summary sits
    // between two pairs that must still pair up. Letting the whole sequence
    // into one run makes its narrowest member — the summary — set the limit
    // for all five, and every ranking stacks full-width on its own row.
    const placed = packComponents(
      seq("ranking", "ranking", "summary", "alert-list", "alert-list"),
    );
    expect(placed.map((entry) => entry.row)).toEqual([0, 0, 1, 2, 2]);
    expect(placed.map((entry) => entry.span)).toEqual([3, 3, 6, 3, 3]);
  });

  it("pairs two flexible components that end up before a full-width one", () => {
    const placed = packComponents(seq("ranking", "ranking", "summary"));
    expect(placed.map((entry) => entry.row)).toEqual([0, 0, 1]);
    expect(placed.map((entry) => entry.span)).toEqual([3, 3, 6]);
  });

  it("packs nothing into nothing", () => {
    expect(packComponents([])).toEqual([]);
  });
});

describe("COMPONENT_LAYOUT", () => {
  it("constrains every component kind the packer can be handed", () => {
    for (const kind of KINDS) {
      const { minSpan, maxSpan } = COMPONENT_LAYOUT[kind];
      // minSpan >= 2 is what keeps a row's item count a divisor of six. A kind
      // admitted at 1 would let five share a row and produce a 1.2-column span.
      expect(minSpan).toBeGreaterThanOrEqual(2);
      expect(LAYOUT_COLUMNS % minSpan).toBe(0);
      expect(maxSpan).toBeLessThanOrEqual(LAYOUT_COLUMNS);
      expect(maxSpan).toBeGreaterThanOrEqual(minSpan);
    }
  });
});
