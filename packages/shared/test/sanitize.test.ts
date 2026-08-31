import { describe, it, expect } from "vitest";
import { sanitizeSegment, truncateToPathBudget, PathTraversalError } from "../src/sanitize.js";

describe("sanitizeSegment", () => {
  it("removes Windows-illegal characters", () => {
    expect(sanitizeSegment('a<b>c:d"e/f\\g|h?i*j')).toBe("abcdefghij");
  });

  it("collapses whitespace runs to a single underscore", () => {
    expect(sanitizeSegment("woman   red    dress")).toBe("woman_red_dress");
  });

  it("collapses doubled separators", () => {
    expect(sanitizeSegment("a___b")).toBe("a_b");
  });

  it("strips trailing dots and spaces (Windows rule)", () => {
    expect(sanitizeSegment("myfolder. ")).toBe("myfolder");
    expect(sanitizeSegment("myfolder...")).toBe("myfolder");
  });

  it("suffixes reserved device names", () => {
    expect(sanitizeSegment("CON")).toBe("CON_");
    expect(sanitizeSegment("com1")).toBe("com1_");
    expect(sanitizeSegment("LPT9")).toBe("LPT9_");
  });

  it("does not treat a normal name containing a reserved word as substring as reserved", () => {
    expect(sanitizeSegment("CONcept")).toBe("CONcept");
  });

  it("rejects a segment that reduces to empty after stripping illegal chars", () => {
    expect(() => sanitizeSegment("///")).toThrow(PathTraversalError);
    expect(() => sanitizeSegment("   ")).toThrow(PathTraversalError);
  });

  it("rejects literal '.' and '..' path-traversal segments", () => {
    expect(() => sanitizeSegment(".")).toThrow(PathTraversalError);
    expect(() => sanitizeSegment("..")).toThrow(PathTraversalError);
  });

  it("supports Korean and emoji content", () => {
    expect(sanitizeSegment("여자 빨간 드레스")).toBe("여자_빨간_드레스");
    expect(sanitizeSegment("hero 🔥 final")).toBe("hero_🔥_final");
  });

  it("truncates to the given max length without splitting a surrogate pair", () => {
    const long = "a".repeat(300);
    expect(sanitizeSegment(long, 50)).toHaveLength(50);

    // 😀 is a surrogate pair (2 UTF-16 code units); cutting at an odd boundary
    // right after many 'a's must not leave a dangling high surrogate.
    const withEmoji = "a".repeat(49) + "😀";
    const result = truncateToPathBudget(withEmoji, 50);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.charCodeAt(result.length - 1)).not.toBeGreaterThanOrEqual(0xd800);
  });
});
