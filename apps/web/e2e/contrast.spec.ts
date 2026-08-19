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
 *
 * The first version of this collector had two holes that let real regressions
 * through, both found by mutating the stylesheet and watching it still pass:
 * form controls render their value and placeholder without owning a text node,
 * and translucent backgrounds were walked past rather than composited, so text
 * on a dark translucent band was judged against the pale page underneath. Both
 * are covered now, and both have a discriminating regression below.
 */

/**
 * Runs in the page. Reports what was painted and makes no judgements, so every
 * threshold stays in the one tested place.
 */
const COLLECT = (where: string): RenderedText[] => {
  /**
   * Background layers nearest-first, ending at the first opaque one. Every
   * layer is kept, including translucent ones: text on `rgba(0, 0, 0, 0.85)`
   * is painted on near-black regardless of what shows through.
   */
  const backgroundStack = (
    start: Element,
  ): { layers: string[]; unsupportedPaint?: string } => {
    const layers: string[] = [];
    let node: Element | null = start;
    while (node !== null) {
      const style = getComputedStyle(node);
      // A gradient or image cannot be reduced to one colour, and approximating
      // it is how a guard starts lying. Report it instead.
      if (style.backgroundImage !== "none") {
        return {
          layers,
          unsupportedPaint: `${node.tagName.toLowerCase()} paints ${style.backgroundImage.slice(0, 60)}, which is not a single colour`,
        };
      }
      const value = style.backgroundColor;
      const body = /^rgba?\(([^)]+)\)$/u.exec(value)?.[1];
      if (body === undefined) {
        return {
          layers,
          unsupportedPaint: `${node.tagName.toLowerCase()} has background ${value}, which is not a colour this can read`,
        };
      }
      const parts = body
        .split(/[,\s/]+/u)
        .filter((part) => part.length > 0)
        .map(Number);
      const alpha = parts[3] ?? 1;
      if (alpha > 0) {
        layers.push(value);
        if (alpha === 1) {
          return { layers };
        }
      }
      node = node.parentElement;
    }
    // Nothing opaque was found. The canvas is white, and saying so explicitly
    // keeps the stack resolvable rather than leaving it open-ended.
    layers.push("rgb(255, 255, 255)");
    return { layers };
  };

  const visible = (element: Element): boolean => {
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    // `.sr-only` hides by clip rather than by display, so it survives the check
    // above while being invisible. Its contrast is not a user-facing fact.
    if (element.closest(".sr-only") !== null) {
      return false;
    }
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };

  const label = (element: Element): string =>
    typeof element.className === "string" && element.className.length > 0
      ? `.${element.className.split(/\s+/u).join(".")}`
      : element.tagName.toLowerCase();

  const samples: RenderedText[] = [];

  const push = (
    element: Element,
    text: string,
    colour: string,
    source: RenderedText["source"],
  ): void => {
    const style = getComputedStyle(element);
    const { layers, unsupportedPaint } = backgroundStack(element);
    samples.push({
      where,
      label: label(element),
      text: text.slice(0, 60),
      color: colour,
      backgroundLayers: layers,
      ...(unsupportedPaint === undefined ? {} : { unsupportedPaint }),
      fontSizePx: Number.parseFloat(style.fontSize),
      fontWeight: Number(style.fontWeight) || 400,
      source,
    });
  };

  for (const element of document.querySelectorAll("*")) {
    if (!visible(element)) {
      continue;
    }
    const style = getComputedStyle(element);

    // Form controls paint their value and placeholder without owning a text
    // node, so the walk below cannot see them. They are the most interactive
    // text on the page and were entirely unchecked before.
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      if (element.type !== "hidden") {
        if (element.value.length > 0) {
          push(element, element.value, style.color, "value");
        } else if (element.placeholder.length > 0) {
          const placeholderColour =
            getComputedStyle(element, "::placeholder").color || style.color;
          push(element, element.placeholder, placeholderColour, "placeholder");
        }
      }
      continue;
    }
    if (element instanceof HTMLSelectElement) {
      const chosen = element.selectedOptions[0]?.textContent?.trim();
      if (chosen !== undefined && chosen.length > 0) {
        push(element, chosen, style.color, "value");
      }
      continue;
    }

    // Only elements owning text directly. Walking every ancestor would report
    // a container's inherited colour against text it does not actually paint.
    const text = Array.from(element.childNodes)
      .filter((node) => node.nodeType === 3 && node.textContent?.trim())
      .map((node) => node.textContent?.trim() ?? "")
      .join(" ");
    if (text.length > 0) {
      push(element, text, style.color, "text");
    }
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

/**
 * Per-state floors, not one global total. A single global floor lets one whole
 * journey stop producing samples while the other five keep the sum above it —
 * the guard would then be blind to an entire page and still report success.
 * The numbers are well under what each state actually yields, so they catch a
 * collapse rather than tracking incidental content changes.
 */
const MINIMUM_SAMPLES: Record<string, number> = {
  "river/1440x1100": 60,
  "river/390x844": 60,
  "enrollment/1440x1100": 25,
  "enrollment/390x844": 25,
  "dashboard-list/1440x1100": 3,
  "dashboard-list/390x844": 3,
};

test("every rendered pair on every journey clears its WCAG AA floor", async ({
  page,
}) => {
  const samples: RenderedText[] = [];
  const counts: Record<string, number> = {};

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    for (const journey of JOURNEYS) {
      await journey.open(page);
      const state = `${journey.name}/${viewport.name}`;
      const collected = await page.evaluate(COLLECT, state);
      counts[state] = collected.length;
      samples.push(...collected);
    }
  }

  // A guard that measured nothing would pass silently forever, and a guard that
  // measured only five of its six states would be half blind while still
  // reporting success.
  const starved = Object.entries(MINIMUM_SAMPLES)
    .filter(([state, floor]) => (counts[state] ?? 0) < floor)
    .map(
      ([state, floor]) =>
        `${state} produced ${String(counts[state] ?? 0)} samples, below its floor of ${String(floor)}`,
    );
  expect(starved, "a journey/viewport stopped producing samples").toEqual([]);

  // Both defects this guard shipped with were collection defects, not
  // arithmetic ones: form-control text was never sampled, and translucent
  // layers were walked past instead of composited. Neither showed up as a
  // failure — the guard simply had less to look at. So the collector's own
  // coverage is asserted, and breaking either path fails here rather than
  // quietly shrinking what is checked.
  const sources = new Set(samples.map((sample) => sample.source));
  expect(
    [...sources].sort(),
    "the collector stopped sampling a kind of rendered text",
  ).toEqual(["placeholder", "text", "value"]);
  expect(
    samples.filter((sample) => sample.backgroundLayers.length > 1).length,
    "no translucent background was composited, so that path is unexercised",
  ).toBeGreaterThan(0);

  const problems = findContrastProblems(samples);
  expect(
    problems.map(describeContrastProblem),
    `${String(problems.length)} of ${String(samples.length)} rendered pairs are below their WCAG AA floor or could not be read`,
  ).toEqual([]);
});
