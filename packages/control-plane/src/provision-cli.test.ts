import { describe, expect, it } from "vitest";

import { parseProvisionArgs } from "./provision-cli";

describe("parseProvisionArgs", () => {
  it("reads an organization, an address, and defaults the role to admin", () => {
    // `admin` by default because the person being provisioned first is the one
    // who will have to invite everyone else. A default of `viewer` would create
    // an organization nobody can administer.
    expect(
      parseProvisionArgs([
        "--organization",
        "Pilot org",
        "--email",
        "person@example.com",
      ]),
    ).toEqual({
      organizationName: "Pilot org",
      email: "person@example.com",
      role: "admin",
    });
  });

  it("accepts an explicit role from the schema's own vocabulary", () => {
    for (const role of ["admin", "editor", "viewer"]) {
      expect(
        parseProvisionArgs([
          "--organization",
          "Org",
          "--email",
          "a@b.co",
          "--role",
          role,
        ]).role,
      ).toBe(role);
    }
  });

  it("refuses a role the memberships table would reject", () => {
    // Caught here rather than as a constraint violation three statements into a
    // transaction, so the operator gets the list of valid roles instead of
    // `memberships_role_check`.
    expect(() =>
      parseProvisionArgs([
        "--organization",
        "Org",
        "--email",
        "a@b.co",
        "--role",
        "owner",
      ]),
    ).toThrow(/admin, editor, viewer/u);
  });

  it("refuses a missing organization or address rather than inventing one", () => {
    expect(() => parseProvisionArgs(["--email", "a@b.co"])).toThrow(
      /--organization is required/u,
    );
    expect(() => parseProvisionArgs(["--organization", "Org"])).toThrow(
      /--email is required/u,
    );
    expect(() => parseProvisionArgs(["--organization", "   "])).toThrow(
      /--organization is required/u,
    );
  });

  it("refuses a flag with no value rather than reading past the end", () => {
    // The pairwise walk would otherwise take `undefined` as the value and write
    // an organization named "undefined".
    expect(() =>
      parseProvisionArgs(["--organization", "Org", "--email"]),
    ).toThrow(/unrecognised argument/u);
    expect(() => parseProvisionArgs(["organization", "Org"])).toThrow(
      /unrecognised argument/u,
    );
  });

  it("reads a uuid as an existing organization to join rather than a name", () => {
    const parsed = parseProvisionArgs([
      "--organization",
      "  6F1E3C2A-9B4D-4E8F-A1B2-C3D4E5F60718 ",
      "--email",
      "a@b.co",
      "--role",
      "viewer",
    ]);

    expect(parsed).toEqual({
      organizationId: "6f1e3c2a-9b4d-4e8f-a1b2-c3d4e5f60718",
      email: "a@b.co",
      role: "viewer",
    });
    expect(parsed.organizationName).toBeUndefined();
  });

  it("treats anything that is not a uuid as a display name", () => {
    // A name that merely resembles an id must still create an organization.
    expect(
      parseProvisionArgs([
        "--organization",
        "6f1e3c2a-9b4d-4e8f-a1b2",
        "--email",
        "a@b.co",
      ]),
    ).toEqual({
      organizationName: "6f1e3c2a-9b4d-4e8f-a1b2",
      email: "a@b.co",
      role: "admin",
    });
  });

  it("trims the organization name the column would reject untrimmed", () => {
    // `organizations_display_name_check` requires `display_name = btrim(...)`.
    expect(
      parseProvisionArgs([
        "--organization",
        "  Pilot org  ",
        "--email",
        "a@b.co",
      ]).organizationName,
    ).toBe("Pilot org");
  });
});
