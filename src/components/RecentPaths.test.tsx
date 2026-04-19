import { describe, it, expect, beforeEach } from "vitest";
import { getRecentPaths, saveRecentPath, MAX_RECENT_PATHS } from "../lib/recentPaths";

describe("Recent Repo Paths", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns empty array when no paths saved", () => {
    expect(getRecentPaths()).toEqual([]);
  });

  it("saves and retrieves a path", () => {
    saveRecentPath("/home/user/project");
    expect(getRecentPaths()).toEqual(["/home/user/project"]);
  });

  it("most recent path comes first", () => {
    saveRecentPath("/first");
    saveRecentPath("/second");
    expect(getRecentPaths()).toEqual(["/second", "/first"]);
  });

  it("deduplicates by moving existing path to front", () => {
    saveRecentPath("/a");
    saveRecentPath("/b");
    saveRecentPath("/c");
    saveRecentPath("/a"); // re-use /a
    expect(getRecentPaths()).toEqual(["/a", "/c", "/b"]);
  });

  it("limits to MAX_RECENT_PATHS entries", () => {
    for (let i = 0; i < 8; i++) {
      saveRecentPath(`/path/${i}`);
    }
    const paths = getRecentPaths();
    expect(paths).toHaveLength(MAX_RECENT_PATHS);
    expect(paths[0]).toBe("/path/7"); // most recent
  });

  it("normalizes trailing slashes", () => {
    saveRecentPath("/home/user/project/");
    expect(getRecentPaths()).toEqual(["/home/user/project"]);
  });

  it("does not save empty paths", () => {
    saveRecentPath("");
    saveRecentPath("/");
    expect(getRecentPaths()).toEqual([]);
  });

  it("handles corrupted localStorage gracefully", () => {
    localStorage.setItem("recent-repo-paths", "not-json{{{");
    expect(getRecentPaths()).toEqual([]);
  });
});
