import { describe, it, expect, vi } from "vitest";
import { formatOrganizeResultMessage, notifyOrganizeResult, notifyError } from "../src/background/notifier.js";
import type { OrganizeBatchItemResult } from "@download-organizer/shared";

function ok(jobId: string, finalPath = "/dest/path/x.png"): OrganizeBatchItemResult {
  return { jobId, ok: true, finalPath };
}
function fail(jobId: string, error = "boom"): OrganizeBatchItemResult {
  return { jobId, ok: false, error, code: "IO_ERROR" };
}

describe("formatOrganizeResultMessage", () => {
  it("reports a clean success summary when nothing failed", () => {
    const { title, message } = formatOrganizeResultMessage([ok("a"), ok("b"), ok("c")]);
    expect(title).toBe("3 assets organized");
    expect(message).toContain("moved");
  });

  it("uses singular wording for exactly one asset", () => {
    const { title } = formatOrganizeResultMessage([ok("a")]);
    expect(title).toBe("1 asset organized");
  });

  it("reports a failure-only summary when everything failed", () => {
    const { title, message } = formatOrganizeResultMessage([fail("a"), fail("b")]);
    expect(title).toContain("failed for 2 assets");
    expect(message).toContain("Inbox");
  });

  it("reports a mixed summary when some succeed and some fail", () => {
    const { title, message } = formatOrganizeResultMessage([ok("a"), ok("b"), fail("c")]);
    expect(title).toBe("2 organized, 1 failed");
    expect(message).toContain("retry");
  });
});

describe("notifyOrganizeResult", () => {
  it("creates exactly one OS notification summarizing the whole batch", () => {
    const create = vi.fn();
    notifyOrganizeResult([ok("a"), fail("b")], { create });

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toBe("aias-organize-result");
  });

  it("creates no notification for an empty batch", () => {
    const create = vi.fn();
    notifyOrganizeResult([], { create });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("notifyError", () => {
  it("creates a uniquely-IDed error notification", () => {
    const create = vi.fn();
    notifyError("Title", "Message", { create });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toMatch(/^aias-error-/);
    expect(create.mock.calls[0][1]).toMatchObject({ title: "Title", message: "Message" });
  });
});
