import { expect, test, type Page } from "@playwright/test";

import {
  describeContrastProblem,
  findContrastProblems,
  type RenderedText,
} from "../test/contrast";

/**
 * Every rendered run of text on every journey must clear its WCAG AA floor.
 *
 * This guard exists because PR #34 shipped a contrast regression that review of
 * the stylesheet did not catch. `--muted` was a plausible grey and passed on
 * white; it failed on all six tinted surfaces the product paints it on. Reading
 * hex values cannot find that. Asking the browser can.
 *
 * The arithmetic lives in `test/contrast.ts` with unit tests against published
 * WCAG anchors. This file only drives the pages and collects what they painted.
 */

/**
 * Runs in the page. Walks every element holding its own text, resolves the
 * effective background through transparent ancestors, and reports what it
 * found — no verdicts, so the thresholds stay in one tested place.
 */
const COLLECT = (where: string): RenderedText[] => {
  const opaqueBackground = (start: Element): string => {
    let node: Element | null = start;
    while (node !== null) {
      const value = getComputedStyle(node).backgroundColor;
      const body = /^rgba?\(([^)]+)\)$/u.exec(value)?.[1];
      if (body !== undefined) {
        const parts = body
          .split(/[,\s/]+/u)
          .filter((part) => part.length > 0)
          .map(Number);
        const alpha = parts[3] ?? 1;
        // Only a fully opaque ancestor settles the question. A translucent one
        // sits over whatever is behind it, so keep walking.
        if (alpha === 1) {
          return `rgb(${String(parts[0])}, ${String(parts[1])}, ${String(parts[2])})`;
        }
      }
      node = node.parentElement;
    }
    return "rgb(255, 255, 255)";
  };

  const samples: RenderedText[] = [];
  for (const element of document.querySelectorAll("*")) {
    // Only elements owning text directly. Walking every ancestor would report
    // a container's inherited colour against text it does not actually paint.
    const text = Array.from(element.childNodes)
      .filter((node) => node.nodeType === 3 && node.textContent?.trim())
      .map((node) => node.textContent?.trim() ?? "")
      .join(" ");
    if (text.length === 0) {
      continue;
    }
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      continue;
    }
    // `.sr-only` hides by clip rather than by display, so it survives the check
    // above while being invisible. Its contrast is not a user-facing fact.
    if (element.closest(".sr-only") !== null) {
      continue;
    }
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) {
      continue;
    }
    samples.push({
      where,
      label:
        typeof element.className === "string" && element.className.length > 0
          ? `.${element.className.split(/\s+/u).join(".")}`
          : element.tagName.toLowerCase(),
      text: text.slice(0, 60),
      color: style.color,
      background: opaqueBackground(element),
      fontSizePx: Number.parseFloat(style.fontSize),
      fontWeight: Number(style.fontWeight) || 400,
    });
  }
  return samples;
};

const VIEWPORTS = [
  { name: "1440x1100", width: 1440, height: 1100 },
  { name: "390x844", width: 390, height: 844 },
] as const;

/**
 * The example chips are hidden on small screens, so a phone has to reach the
 * enrollment dashboard the way a person would — through the pinned input.
 */
async function buildEnrollment(page: Page): Promise<void> {
  const chip = page.getByRole("button", {
    name: "Current student enrollment at UC Riverside",
  });
  if (await chip.isVisible()) {
    await chip.click();
  } else {
    await page
      .locator("#dashboard-request")
      .fill("Current student enrollment at UC Riverside");
    await page.getByRole("button", { name: "Build dashboard" }).click();
  }
  await expect(
    page.getByRole("heading", { name: "UC Riverside Enrollment — Fall 2025" }),
  ).toBeVisible();
}

const JOURNEYS = [
  {
    name: "river",
    open: async (page: Page) => {
      await page.goto("/");
      await expect(
        page.getByRole("heading", { name: "Sacramento River Conditions" }),
      ).toBeVisible();
    },
  },
  {
    name: "enrollment",
    open: async (page: Page) => {
      await page.goto("/");
      await buildEnrollment(page);
    },
  },
  {
    name: "dashboard-list",
    open: async (page: Page) => {
      await page.goto("/dashboards");
      await expect(
        page.getByRole("heading", { name: "Your dashboards" }),
      ).toBeVisible();
    },
  },
] as const;

test("every rendered pair on every journey clears its WCAG AA floor", async ({
  page,
}) => {
  const samples: RenderedText[] = [];

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    for (const journey of JOURNEYS) {
      await journey.open(page);
      samples.push(
        ...(await page.evaluate(COLLECT, `${journey.name}/${viewport.name}`)),
      );
    }
  }

  // A guard that measured nothing would pass silently forever. The suite has
  // hundreds of text runs across six page-viewport combinations; a collapse to
  // near-zero means the collector broke, not that the palette got better.
  expect(samples.length).toBeGreaterThan(100);

  const problems = findContrastProblems(samples);
  expect(
    problems.map(describeContrastProblem),
    `${String(problems.length)} of ${String(samples.length)} rendered pairs are below their WCAG AA floor`,
  ).toEqual([]);
});
