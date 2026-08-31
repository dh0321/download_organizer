import { describe, it, expect } from "vitest";
import { buildFilename, type BuildFilenameTokens } from "../src/naming.js";

const TEMPLATE = "{shot}_{type}_{description}_{index}";

function tokens(overrides: Partial<BuildFilenameTokens> = {}): BuildFilenameTokens {
  return {
    project: "Galaxy_S27",
    sequence: "SQ010",
    shot: "SH020",
    description: "woman red dress closeup",
    type: "IMG",
    index: 23,
    customFilenameEnabled: false,
    customFilename: "",
    ...overrides,
  };
}

describe("buildFilename", () => {
  it("builds the full example from the spec", () => {
    expect(buildFilename(TEMPLATE, tokens(), ".png")).toBe("SH020_IMG_woman_red_dress_closeup_023.png");
  });

  it("preserves the original media extension for video", () => {
    expect(buildFilename(TEMPLATE, tokens({ type: "VID", index: 24 }), ".mov")).toBe(
      "SH020_VID_woman_red_dress_closeup_024.mov",
    );
  });

  it("drops the description segment (no double separator) when description is empty", () => {
    expect(buildFilename(TEMPLATE, tokens({ description: "" }), ".png")).toBe("SH020_IMG_023.png");
  });

  it("drops the description segment when description is whitespace-only", () => {
    expect(buildFilename(TEMPLATE, tokens({ description: "   " }), ".png")).toBe("SH020_IMG_023.png");
  });

  it("falls back identifier: shot -> sequence -> project -> 'asset'", () => {
    expect(buildFilename(TEMPLATE, tokens({ shot: "", description: "" }), ".png")).toBe("SQ010_IMG_023.png");
    expect(buildFilename(TEMPLATE, tokens({ shot: "", sequence: "", description: "" }), ".png")).toBe(
      "Galaxy_S27_IMG_023.png",
    );
    expect(
      buildFilename(TEMPLATE, tokens({ shot: "", sequence: "", project: "", description: "" }), ".png"),
    ).toBe("asset_IMG_023.png");
  });

  it("zero-pads the index to 3 digits", () => {
    expect(buildFilename(TEMPLATE, tokens({ index: 1 }), ".png")).toBe(
      "SH020_IMG_woman_red_dress_closeup_001.png",
    );
  });

  it("uses the custom filename verbatim (sanitized) and ignores the naming template entirely", () => {
    const result = buildFilename(TEMPLATE, tokens({ customFilenameEnabled: true, customFilename: "hero final" }), ".mov");
    expect(result).toBe("hero_final.mov");
  });

  it("sanitizes an unsafe custom filename", () => {
    const result = buildFilename(
      TEMPLATE,
      tokens({ customFilenameEnabled: true, customFilename: 'bad<>name' }),
      ".png",
    );
    expect(result).toBe("badname.png");
  });
});
