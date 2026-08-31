import { describe, it, expect } from "vitest";
import {
  resolveDestinationFolderSegments,
  conflictCandidateFilename,
  MissingRequiredFieldError,
} from "../src/path.js";
import { PathTraversalError } from "../src/sanitize.js";
import type { FolderLevel } from "../src/types.js";

const LEVELS: FolderLevel[] = [
  { key: "project", label: "Project", order: 0, required: true },
  { key: "sequence", label: "Sequence", order: 1, required: false },
  { key: "shot", label: "Shot", order: 2, required: false },
];

describe("resolveDestinationFolderSegments", () => {
  it("includes every level plus the bucket when all are present", () => {
    const segments = resolveDestinationFolderSegments(
      LEVELS,
      { project: "Galaxy_S27", sequence: "SQ010", shot: "SH020" },
      "Generated",
    );
    expect(segments).toEqual(["Galaxy_S27", "SQ010", "SH020", "Generated"]);
  });

  it("drops an empty optional level entirely — no blank segment, no hole in the path", () => {
    const segments = resolveDestinationFolderSegments(
      LEVELS,
      { project: "Galaxy_S27", sequence: "", shot: "SH020" },
      "Generated",
    );
    expect(segments).toEqual(["Galaxy_S27", "SH020", "Generated"]);
  });

  it("drops multiple empty optional levels", () => {
    const segments = resolveDestinationFolderSegments(
      LEVELS,
      { project: "Galaxy_S27", sequence: "", shot: "" },
      "Generated",
    );
    expect(segments).toEqual(["Galaxy_S27", "Generated"]);
  });

  it("throws MissingRequiredFieldError when a required level is empty", () => {
    expect(() =>
      resolveDestinationFolderSegments(LEVELS, { project: "", sequence: "SQ010", shot: "SH020" }, "Generated"),
    ).toThrow(MissingRequiredFieldError);
  });

  it("rejects a path-traversal attempt disguised as a field value", () => {
    expect(() =>
      resolveDestinationFolderSegments(LEVELS, { project: "..", sequence: "", shot: "" }, "Generated"),
    ).toThrow(PathTraversalError);
  });

  it("sanitizes every segment including the bucket", () => {
    const segments = resolveDestinationFolderSegments(
      LEVELS,
      { project: "Galaxy:S27", sequence: "", shot: "" },
      "Gener<ated",
    );
    expect(segments).toEqual(["GalaxyS27", "Generated"]);
  });
});

describe("conflictCandidateFilename", () => {
  it("returns the plain name on attempt 0", () => {
    expect(conflictCandidateFilename("hero", ".mov", 0)).toBe("hero.mov");
  });

  it("appends _002, _003, ... starting from attempt 1", () => {
    expect(conflictCandidateFilename("hero", ".mov", 1)).toBe("hero_002.mov");
    expect(conflictCandidateFilename("hero", ".mov", 2)).toBe("hero_003.mov");
  });
});
