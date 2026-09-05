import { profileTable } from "@dasher/workbook";
import { describe, expect, it } from "vitest";

import { requestMessage } from "./prompt";
import type { PlanningRequest } from "./provider";

const DISTINCTIVE_SAMPLE = "SYNTHETIC-ROW-VALUE-MUST-NOT-LEAVE";
const DISTINCTIVE_LISTED_VALUE = "SYNTHETIC-LISTED-VALUE-MUST-NOT-LEAVE";

function planningRequest(): PlanningRequest {
  const table = profileTable({
    headers: ["Region", "Revenue"],
    rows: [
      [DISTINCTIVE_SAMPLE, "4200"],
      ["South", "5100"],
    ],
  });
  return {
    requestText: "Revenue by region",
    sourceName: "synthetic-dataset",
    table: {
      columns: table.columns,
      rowCount: table.rowCount,
      values: { Region: [DISTINCTIVE_SAMPLE, DISTINCTIVE_LISTED_VALUE] },
    },
  };
}

describe("stage 1 model request minimisation", () => {
  it("serializes no raw cell samples or listed values", () => {
    const serialized = requestMessage(planningRequest());
    expect(serialized).not.toContain(DISTINCTIVE_SAMPLE);
    expect(serialized).not.toContain(DISTINCTIVE_LISTED_VALUE);
    expect(serialized).not.toMatch(/"samples"\s*:/u);
    expect(serialized).not.toMatch(/"values"\s*:/u);
  });

  it("keeps only safe source-neutral profile metadata and semantic interpretation", () => {
    const serialized = requestMessage(planningRequest());
    expect(serialized).toContain("Dataset: synthetic-dataset, 2 rows");
    expect(serialized).not.toMatch(/\b(?:file|spreadsheet)\b/iu);
    expect(serialized).toContain('"name": "Revenue"');
    expect(serialized).toContain('"type": "number"');
    expect(serialized).toContain('"semanticKind": "measure"');
    expect(serialized).toContain('"nonEmpty": 2');
    expect(serialized).toContain('"distinct": 2');
  });
});
