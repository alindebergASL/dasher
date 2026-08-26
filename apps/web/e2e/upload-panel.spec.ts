import { expect, test, type Page } from "@playwright/test";

/**
 * What the upload panel actually renders, measured rather than reasoned about.
 *
 * WHY THIS FILE EXISTS. Two defects shipped in the panel's first version and
 * both were invisible to every other gate: an input rendered 352px tall on
 * desktop, and all six labels were `display: none` below 641px, leaving a phone
 * with six controls and no accessible name at all. Unit tests render into jsdom,
 * which computes no layout and applies no stylesheet; the contrast spec samples
 * colour, not size or visibility; and the upload journey spec asserts text.
 * Nothing looked at the page.
 *
 * Both defects came from the same root: `.request-input` and `.request-label`
 * were written for the request bar, and reusing their class names in a panel
 * with a different flex direction and a different mobile rule inherited
 * behaviour nobody chose. So this measures the properties those rules govern —
 * a control's height, and whether its name is announced — rather than asserting
 * particular CSS.
 *
 * NO DATABASE NEEDED. The panel renders whether or not an upload could succeed,
 * so this belongs in the ordinary browser suite rather than the persistence job.
 */

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1100 },
  { name: "mobile", width: 390, height: 844 },
] as const;

/** Every control in the panel, with the label a reader should hear. */
const CONTROLS = [
  ["upload-file", "Ledger export (CSV)"],
  ["upload-request", "What should the dashboard show?"],
  ["upload-source-name", "What is this export called?"],
  ["upload-currency", "Currency"],
  ["upload-period-label", "One column is a…"],
  ["upload-exported-on", "Exported on"],
] as const;

/** A single-line text input is around 40px. Anything near 300 is a layout bug. */
const TALLEST_REASONABLE_INPUT = 80;

async function openPanel(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator(".upload-summary").click();
  await expect(page.locator("#upload-file")).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test.describe(`the upload panel at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("gives every control a name a screen reader can announce", async ({
      page,
    }) => {
      // The mobile rule `.request-label { display: none }` hid all six. A label
      // that exists in the DOM and is not displayed contributes nothing to the
      // accessible name, so this asks the browser what the name IS rather than
      // whether a `<label>` element exists.
      await openPanel(page);

      for (const [id, expected] of CONTROLS) {
        const name = await page.locator(`#${id}`).evaluate((element) => {
          const label = document.querySelector(
            `label[for="${element.id}"]`,
          ) as HTMLElement | null;
          if (label === null) return "";
          return getComputedStyle(label).display === "none"
            ? ""
            : (label.textContent ?? "").trim();
        });

        expect(name, `#${id} has no announced name`).toBe(expected);
      }
    });

    test("renders every input at the height of an input", async ({ page }) => {
      // `.request-input` carries `flex: 1 1 22rem`, a WIDTH basis in the
      // request bar's row-direction container and a HEIGHT basis in this
      // panel's column-direction one. `#upload-request` rendered 352px until
      // the neutralising rule stopped naming only the grid fields.
      await openPanel(page);

      for (const [id] of CONTROLS) {
        const box = await page.locator(`#${id}`).boundingBox();

        expect(box, `#${id} has no box`).not.toBeNull();
        expect(
          box!.height,
          `#${id} is ${String(box!.height)}px tall`,
        ).toBeLessThan(TALLEST_REASONABLE_INPUT);
      }
    });

    test("does not push the page sideways", async ({ page }) => {
      await openPanel(page);

      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        ),
      ).toBe(false);
    });
  });
}

test.describe("the panel closed", () => {
  test("keeps the executive brief inside the first mobile viewport", async ({
    page,
  }) => {
    // The rule the pinned request bar exists to satisfy, which the collapsed
    // disclosure broke by 20px when it was first added as a sibling in the
    // flow. Asserted here as well as in the river spec because this panel is
    // what put height there.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    const brief = page.getByRole("region", { name: "Executive brief" });
    const box = await brief.boundingBox();

    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  });
});
