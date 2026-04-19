import { describe, it, expect, beforeEach } from "vitest";
import { hasSeenRenameTip, markRenameTipSeen, shouldShowRenameTip } from "../lib/renameTip";

describe("Rename Tip", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("should not have the tip flag set initially", () => {
    expect(hasSeenRenameTip()).toBe(false);
  });

  it("should persist the flag after being set", () => {
    markRenameTipSeen();
    expect(hasSeenRenameTip()).toBe(true);
  });

  it("should not show tip again after flag is set", () => {
    markRenameTipSeen();
    expect(shouldShowRenameTip(1)).toBe(false);
  });

  it("should show tip when no flag and sessions exist", () => {
    expect(shouldShowRenameTip(1)).toBe(true);
  });

  it("should not show tip when sessions are empty", () => {
    expect(shouldShowRenameTip(0)).toBe(false);
  });

  it("handles flag removal correctly", () => {
    markRenameTipSeen();
    localStorage.removeItem("seen-rename-tip");
    expect(shouldShowRenameTip(1)).toBe(true);
  });
});
