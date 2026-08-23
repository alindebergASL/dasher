import { describe, expect, it } from "vitest";

import { DOMAIN_CATALOG } from "./domains";
import { combinedProvenance, provenanceOf } from "./provenance";

describe("provenanceOf", () => {
  it("names the deterministic planner this app actually constructs", () => {
    // Not a string chosen to look right: the catalog's own provider, asked.
    // The call site used to record `{ provider: "fake", model: "fake-planner" }`,
    // which named nothing in this repository.
    expect(provenanceOf(DOMAIN_CATALOG.river.provider)).toStrictEqual({
      provider: "deterministic",
      model: "fake-keyword-planner-v1",
    });
  });

  it("gives both sensor domains the same record, because one planner plans both", () => {
    expect(provenanceOf(DOMAIN_CATALOG.air.provider)).toStrictEqual(
      provenanceOf(DOMAIN_CATALOG.river.provider),
    );
  });

  it("splits a model-backed provider into vendor and model", () => {
    // The shape `AnthropicPlanningProvider` already produces. Asserted now so
    // the record is right on the day it is wired in, rather than discovered to
    // be wrong afterwards.
    expect(
      provenanceOf({ id: "anthropic:claude-opus-5", usesModel: true }),
    ).toStrictEqual({ provider: "anthropic", model: "claude-opus-5" });
  });

  it("keeps a vendorless id whole rather than inventing a split", () => {
    expect(provenanceOf({ id: "somemodel", usesModel: true })).toStrictEqual({
      provider: "somemodel",
      model: "somemodel",
    });
  });

  it("splits on the first colon, so a model id may contain one", () => {
    expect(
      provenanceOf({ id: "vendor:family:v2", usesModel: true }),
    ).toStrictEqual({ provider: "vendor", model: "family:v2" });
  });

  it("fits the persisted columns, which are varchar(64)", () => {
    const { provider, model } = provenanceOf({
      id: "anthropic:claude-opus-5",
      usesModel: true,
    });

    expect(provider.length).toBeLessThanOrEqual(64);
    expect(model.length).toBeLessThanOrEqual(64);
  });
});

describe("combinedProvenance", () => {
  it("collapses two identical planners into one name", () => {
    // Today's real case: both sensor domains hold the same deterministic
    // planner, so a combined dashboard should read like a single-source one.
    expect(
      combinedProvenance([
        DOMAIN_CATALOG.river.provider,
        DOMAIN_CATALOG.air.provider,
      ]),
    ).toStrictEqual(provenanceOf(DOMAIN_CATALOG.river.provider));
  });

  it("names both when two different planners built the halves", () => {
    expect(
      combinedProvenance([
        { id: "anthropic:m", usesModel: true },
        { id: "fake-keyword-planner-v1", usesModel: false },
      ]),
    ).toStrictEqual({
      provider: "anthropic+deterministic",
      model: "m+fake-keyword-planner-v1",
    });
  });
});
