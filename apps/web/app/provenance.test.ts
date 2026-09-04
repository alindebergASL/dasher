// @vitest-environment node
import { describe, expect, it } from "vitest";

import { provenanceOf } from "./provenance";

describe("provenanceOf", () => {
  it("records a deterministic planner as such", () => {
    expect(
      provenanceOf({ id: "fake-table-planner", usesModel: false }),
    ).toEqual({ provider: "deterministic", model: "fake-table-planner" });
  });

  it("splits a model planner's id into provider and model", () => {
    expect(
      provenanceOf({ id: "anthropic:claude-opus-5", usesModel: true }),
    ).toEqual({ provider: "anthropic", model: "claude-opus-5" });
  });

  it("uses the whole id when there is no separator", () => {
    expect(provenanceOf({ id: "local", usesModel: true })).toEqual({
      provider: "local",
      model: "local",
    });
  });
});
