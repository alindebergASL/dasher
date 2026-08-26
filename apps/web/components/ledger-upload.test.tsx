import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlanResult } from "../app/planning";

import { LedgerUpload } from "./ledger-upload";

/**
 * Where an upload refusal is shown, and what the form does with a file.
 *
 * The refusals themselves are decided in `app/upload.ts` and tested there. What
 * is only observable here is the seam: that the bytes reach the action as a
 * file rather than as a string, that the declared fields travel with them, and
 * that a refusal appears beside the form the reader still has open instead of
 * at the top of a page they have scrolled away from.
 */

const { uploadLedgerDashboard } = vi.hoisted(() => ({
  uploadLedgerDashboard: vi.fn(),
}));

vi.mock("@/app/actions", () => ({ uploadLedgerDashboard }));

const REFUSED: PlanResult = {
  ok: false,
  error:
    "That file is not UTF-8 text. Re-export it as CSV UTF-8 and try again.",
};

const BUILT: PlanResult = {
  ok: true,
  dashboard: {
    schemaVersion: "1.2",
    title: "Operating spend",
    audience: "Finance leads",
    framing: "Where the money went.",
    pages: [],
    evidence: [],
  } as unknown as NonNullable<PlanResult["dashboard"]>,
  attempts: 1,
  dashboardId: "1cf2ec5c-6a0c-4d0e-9f0f-2f4a5b6c7d8e",
};

const csvFile = () =>
  new File(
    [
      "line_id,label,budget_per_period,2026-03,2026-04\r\ncloud,Cloud,100,10,20\r\n",
    ],
    "operating-spend.csv",
    { type: "text/csv" },
  );

function fillAndSubmit(file: File) {
  // The disclosure is not opened: jsdom renders a closed `details` element's
  // contents, and clicking the summary would be testing jsdom rather than this
  // component. What a reader has to open is a browser behaviour and belongs to
  // the end-to-end suite.
  fireEvent.change(screen.getByLabelText("Ledger export (CSV)"), {
    target: { files: [file] },
  });
  fireEvent.change(screen.getByLabelText("Exported on"), {
    target: { value: "2026-08-24" },
  });
  // Submitted on the form rather than by clicking the button: jsdom does not
  // implement form submission from a button click, so a click here would assert
  // nothing and pass for the wrong reason.
  const submit = screen.getByRole("button", { name: "Build from this file" });
  fireEvent.submit(submit.closest("form") as HTMLFormElement);
}

beforeEach(() => {
  uploadLedgerDashboard.mockReset();
});

describe("LedgerUpload", () => {
  it("sends the file and every declared detail in one form", async () => {
    uploadLedgerDashboard.mockResolvedValue(BUILT);
    render(<LedgerUpload disabled={false} onBuilt={vi.fn()} />);

    await fillAndSubmit(csvFile());

    await waitFor(() => {
      expect(uploadLedgerDashboard).toHaveBeenCalledTimes(1);
    });
    const data = uploadLedgerDashboard.mock.calls[0]?.[0] as FormData;

    // A File, not a string. The bytes are streamed by the browser and never
    // become text in this component; anything else would mean the file existing
    // twice, once in a shape nothing needs.
    expect(data.get("file")).toBeInstanceOf(File);
    // Not the filename: jsdom builds the entry from a `files` list this test
    // had to define itself, and loses the name doing it. That the name reaches
    // the server is a browser behaviour, and the end-to-end suite checks it by
    // reading it back off the dashboard's source line.
    // The four things a CSV cannot say about itself, plus the brief.
    expect(data.get("sourceName")).toBe("Operating ledger export");
    expect(data.get("currency")).toBe("USD");
    expect(data.get("periodLabel")).toBe("month");
    expect(data.get("exportedOn")).toBe("2026-08-24");
    expect(data.get("request")).toBe("Operating spend by category");
  });

  it("shows a refusal beside the form rather than handing it upward", async () => {
    // The form stays open with the field the reader has to change in it. The
    // same sentence at the top of the page, above a still-open form, would be
    // the right message in the wrong place — and shown twice.
    const onBuilt = vi.fn();
    uploadLedgerDashboard.mockResolvedValue(REFUSED);
    render(<LedgerUpload disabled={false} onBuilt={onBuilt} />);

    await fillAndSubmit(csvFile());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "not UTF-8 text",
    );
    expect(onBuilt).not.toHaveBeenCalled();
  });

  it("hands a built dashboard upward, and clears the refusal it replaces", async () => {
    const onBuilt = vi.fn();
    uploadLedgerDashboard.mockResolvedValueOnce(REFUSED);
    uploadLedgerDashboard.mockResolvedValueOnce(BUILT);
    render(<LedgerUpload disabled={false} onBuilt={onBuilt} />);

    await fillAndSubmit(csvFile());
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    await fillAndSubmit(csvFile());

    await waitFor(() => {
      expect(onBuilt).toHaveBeenCalledWith(
        BUILT,
        "Operating spend by category",
      );
    });
    // A stale refusal under a dashboard that has just been built would say the
    // upload failed while the reader looks at what it produced.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("cannot be submitted while the other form is working", () => {
    render(<LedgerUpload disabled onBuilt={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: "Build from this file" }),
    ).toBeDisabled();
  });
});
