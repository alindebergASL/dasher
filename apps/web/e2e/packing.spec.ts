import { expect, test, type Page } from "@playwright/test";

/**
 * Packing v1, measured in a real browser.
 *
 * Every assertion here fails on the layout this replaced, where each component
 * kind hardcoded its own width in renderer JSX: five of seven asked for the
 * full row, so whatever was left over was stranded — a ranking alone in one of
 * three columns, a short card floating above a hole beside a taller map.
 *
 * The tolerance is 1px throughout, for sub-pixel column arithmetic. It is not
 * slack for a wrong answer: the gaps these tests were written against were
 * 726px and 240px.
 */

const TOLERANCE = 1;

interface PanelBox {
  readonly title: string;
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly top: number;
  readonly height: number;
  /** How far the panel's content exceeds its own box. */
  readonly overflow: number;
  readonly span: string | null;
}

async function panelBoxes(page: Page): Promise<PanelBox[]> {
  return page
    .locator(".dashboard-grid")
    .first()
    .evaluate((grid) =>
      [...grid.children].map((panel) => {
        const box = panel.getBoundingClientRect();
        return {
          title: panel.querySelector("h2")?.textContent?.trim() ?? "",
          left: box.left,
          right: box.right,
          width: box.width,
          top: box.top,
          height: box.height,
          overflow: panel.scrollWidth - panel.clientWidth,
          span: panel.getAttribute("data-span"),
        };
      }),
    );
}

async function gridBox(page: Page) {
  return page
    .locator(".dashboard-grid")
    .first()
    .evaluate((grid) => {
      const box = grid.getBoundingClientRect();
      return { left: box.left, right: box.right };
    });
}

/** Panels sharing a top edge are on the same row. */
function rowsOf(panels: readonly PanelBox[]): PanelBox[][] {
  const rows: PanelBox[][] = [];
  for (const panel of panels) {
    const last = rows.at(-1);
    if (last && Math.abs(last[0]!.top - panel.top) <= TOLERANCE) {
      last.push(panel);
    } else {
      rows.push([panel]);
    }
  }
  return rows;
}

function expectFullRows(
  rows: readonly PanelBox[][],
  grid: { left: number; right: number },
) {
  for (const row of rows) {
    // No row starts short of the grid, and none — the last one included —
    // stops short of it. This is the assertion the ragged tail failed.
    expect(Math.abs(row[0]!.left - grid.left)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(row.at(-1)!.right - grid.right)).toBeLessThanOrEqual(
      TOLERANCE,
    );
  }
}

function expectEqualHeights(rows: readonly PanelBox[][]) {
  for (const row of rows) {
    for (const panel of row) {
      expect(Math.abs(panel.height - row[0]!.height)).toBeLessThanOrEqual(
        TOLERANCE,
      );
    }
  }
}

test("a combined dashboard packs into full rows of equal-height peers", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("What do you want to monitor?")
    .fill("Compare river conditions and air quality near Sacramento");
  await page.getByRole("button", { name: "Build dashboard" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "River and Air quality — combined conditions",
  );

  const panels = await panelBoxes(page);
  const rows = rowsOf(panels);
  expect(panels.length).toBeGreaterThan(3);

  expectFullRows(rows, await gridBox(page));
  // Before: the map was 710px and the ranking beside it 347px and 240px
  // shorter, so the ranking hung in mid-air. Peers now share a row's height.
  expectEqualHeights(rows);

  // The specific pairing this dashboard produces: the gauge map and the ranking
  // beside it, as equal halves. Before, they were two thirds and one third of a
  // three-column grid. Naming both panels matters — taking whichever row
  // happens to hold two would pass on some other pair — and so does comparing
  // their widths absolutely: a signed difference is satisfied by a first panel
  // that is arbitrarily narrower than the second.
  const map = panels.find((panel) => panel.title === "Gauge map");
  const ranking = panels.find(
    (panel) => panel.title === "Fastest-rising gauges",
  );
  expect(map).toBeDefined();
  expect(ranking).toBeDefined();
  expect(Math.abs(map!.top - ranking!.top)).toBeLessThanOrEqual(TOLERANCE);
  expect([map!.span, ranking!.span]).toEqual(["3", "3"]);
  expect(Math.abs(map!.width - ranking!.width)).toBeLessThanOrEqual(TOLERANCE);
  expect(map!.left).toBeLessThan(ranking!.left);
});

test("an enrollment dashboard leaves no stranded panel in its last row", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("What do you want to monitor?")
    .fill("Current student enrollment at UC Riverside");
  await page.getByRole("button", { name: "Build dashboard" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const panels = await panelBoxes(page);
  const rows = rowsOf(panels);
  expect(rows.length).toBeGreaterThan(1);

  // Before: the trailing ranking sat 347px wide in one of three columns, with
  // 726px of empty grid beside it.
  const grid = await gridBox(page);
  expectFullRows(rows, grid);
  expect(Math.abs(rows.at(-1)![0]!.left - grid.left)).toBeLessThanOrEqual(
    TOLERANCE,
  );
});

test("the river dashboard renders in reading order at full width", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Sacramento River Conditions",
  );

  const panels = await panelBoxes(page);
  const rows = rowsOf(panels);
  expectFullRows(rows, await gridBox(page));
  expectEqualHeights(rows);

  // Order is the plan's, not the packer's: the packer decides width only.
  const headings = await page
    .locator(".dashboard-grid .panel h2")
    .allTextContents();
  expect(panels.map((panel) => panel.title)).toEqual(
    headings.map((heading) => heading.trim()),
  );
});

/**
 * Below 1050px the six-column grid gives every component the full row.
 *
 * The first version of this slice deleted the base stylesheet's 1050px rule and
 * claimed six columns held down to 760px. They do not: at 761px the map and the
 * ranking were 214.6px each, the ranking's content was 40px wider than its own
 * panel, and the document itself gained 9px of horizontal scroll. These widths
 * are the ones that failed.
 */
for (const width of [761, 800]) {
  test(`at ${width}px nothing overflows and every row stays full`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    await page
      .getByLabel("What do you want to monitor?")
      .fill("Compare river conditions and air quality near Sacramento");
    await page.getByRole("button", { name: "Build dashboard" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "River and Air quality — combined conditions",
    );

    // The page does not scroll sideways.
    const document = await page.evaluate(() => ({
      scrollWidth: window.document.documentElement.scrollWidth,
      clientWidth: window.document.documentElement.clientWidth,
    }));
    expect(document.scrollWidth).toBe(document.clientWidth);

    const panels = await panelBoxes(page);
    const grid = await gridBox(page);

    // No panel's content is wider than the panel.
    for (const panel of panels) {
      expect(panel.overflow).toBeLessThanOrEqual(0);
    }

    // The map is not squeezed into a half of a narrow grid.
    const map = panels.find((panel) => panel.title === "Gauge map");
    expect(map).toBeDefined();
    expect(Math.abs(map!.width - (grid.right - grid.left))).toBeLessThanOrEqual(
      TOLERANCE,
    );

    expectFullRows(rowsOf(panels), grid);
  });
}

/**
 * A selected station must never make its neighbour unreachable.
 *
 * `.map-selection` is an absolutely positioned card inside the map, so it sits
 * on top of the markers. Selecting one station put that card over a neighbour,
 * and the neighbour then could not be clicked at all. This is a function of how
 * wide the card is relative to the map, not of the viewport: it reproduced on
 * the base stylesheet at 1051px, and packing v1 narrowed the map, which carried
 * the same failure up to 1261px.
 *
 * 1200px is the width the failure was reported at. 1300px is the narrowest
 * viewport on this branch where the map is a half rather than a full row, so it
 * is the one that still exercises the overlap after the grid's collapse point
 * moved; a run with `pointer-events` removed from the card fails there and
 * passes at 1200px.
 */
for (const width of [1200, 1300]) {
  test(`at ${width}px a second marker can be selected after the first`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    await page
      .getByLabel("What do you want to monitor?")
      .fill("Compare river conditions and air quality near Sacramento");
    await page.getByRole("button", { name: "Build dashboard" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "River and Air quality — combined conditions",
    );

    const markers = page.locator(".map-marker");
    await expect(markers.first()).toBeVisible();
    expect(await markers.count()).toBeGreaterThan(1);

    await markers.nth(0).click();
    await expect(markers.nth(0)).toHaveAttribute("aria-pressed", "true");

    // An ordinary click, not a forced one: a forced click would pass straight
    // through the card and prove nothing about what a reader can reach.
    await markers.nth(1).click();
    await expect(markers.nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(markers.nth(0)).toHaveAttribute("aria-pressed", "false");
  });
}
