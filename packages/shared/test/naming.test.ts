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
    expect(buildFilename(TEMPLATE, tokens(), ".png")).toBe("SH020_IMG_woman_red_dress_closeup_v023.png");
  });

  it("preserves the original media extension for video", () => {
    expect(buildFilename(TEMPLATE, tokens({ type: "VID", index: 24 }), ".mov")).toBe(
      "SH020_VID_woman_red_dress_closeup_v024.mov",
    );
  });

  it("drops the description segment (no double separator) when description is empty", () => {
    expect(buildFilename(TEMPLATE, tokens({ description: "" }), ".png")).toBe("SH020_IMG_v023.png");
  });

  it("drops the description segment when description is whitespace-only", () => {
    expect(buildFilename(TEMPLATE, tokens({ description: "   " }), ".png")).toBe("SH020_IMG_v023.png");
  });

  it("falls back to 'untitled' when shot is empty — never borrows Project or Sequence, since both are shared across many assets", () => {
    expect(buildFilename(TEMPLATE, tokens({ shot: "", description: "" }), ".png")).toBe("untitled_IMG_v023.png");
    expect(buildFilename(TEMPLATE, tokens({ shot: "", sequence: "", description: "" }), ".png")).toBe(
      "untitled_IMG_v023.png",
    );
    expect(
      buildFilename(TEMPLATE, tokens({ shot: "", sequence: "SQ010", project: "Galaxy_S27", description: "" }), ".png"),
    ).toBe("untitled_IMG_v023.png");
  });

  it("zero-pads the index to 3 digits, prefixed with 'v'", () => {
    expect(buildFilename(TEMPLATE, tokens({ index: 1 }), ".png")).toBe(
      "SH020_IMG_woman_red_dress_closeup_v001.png",
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

  it("includes the {source} token when present in the template", () => {
    expect(buildFilename("{shot}_{source}_{index}", tokens({ source: "chatgpt" }), ".png")).toBe(
      "SH020_chatgpt_v023.png",
    );
  });

  it("drops the source segment when source is empty", () => {
    expect(buildFilename("{shot}_{source}_{index}", tokens({ source: "" }), ".png")).toBe("SH020_v023.png");
  });

  it("uses each token's own value regardless of position — {shot} isn't the only slot eligible for the identifier fallback (regression: a non-shot token at position 0 must not be silently replaced by the fallback chain)", () => {
    // description at position 0 must use the real description, not the shot fallback
    expect(buildFilename("{description}_{index}", tokens(), ".png")).toBe("woman_red_dress_closeup_v023.png");
    // {shot} still falls back to "untitled" wherever it appears, even mid-template
    expect(buildFilename("{description}_{shot}_{index}", tokens({ shot: "" }), ".png")).toBe(
      "woman_red_dress_closeup_untitled_v023.png",
    );
  });
});
