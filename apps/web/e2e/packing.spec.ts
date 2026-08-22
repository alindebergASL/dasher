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
  readonly top: number;
  readonly height: number;
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
          top: box.top,
          height: box.height,
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

  // The specific pairing this dashboard produces: a map and a ranking as equal
  // halves. Before, they were two thirds and one third of a three-column grid.
  const shared = rows.find((row) => row.length === 2);
  expect(shared).toBeDefined();
  expect(shared!.map((panel) => panel.span)).toEqual(["3", "3"]);
  expect(
    Math.abs(shared![0]!.right - shared![0]!.left) -
      Math.abs(shared![1]!.right - shared![1]!.left),
  ).toBeLessThanOrEqual(TOLERANCE);
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
