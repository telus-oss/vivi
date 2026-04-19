import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const { mockExecFileSync, mockExecSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockExecSync: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const mod = { execSync: mockExecSync, execFileSync: mockExecFileSync };
  return { ...mod, default: mod };
});

vi.mock("./container.js", () => ({
  getContainerName: vi.fn((id: string) => `vivi-sandbox-${id}`),
  getSession: vi.fn((id: string) => ({
    id,
    status: "running",
    repoPath: "/home/user/myrepo",
    containerRef: id,
  })),
}));

vi.mock("./runtime.js", () => ({
  runtime: { bin: "docker" },
}));

vi.mock("./db.js", () => ({
  default: {
    prepare: vi.fn(() => ({ all: vi.fn(), get: vi.fn(), run: vi.fn() })),
  },
}));

// Import after mocks
import { createPrRequest, getPrDiff, getPrFile } from "./pr.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedPr(overrides: Partial<{ branch: string; baseBranch: string }> = {}) {
  return createPrRequest("sess-1", {
    title: "My PR",
    description: "A test PR",
    branch: overrides.branch ?? "feat/my-feature",
    baseBranch: overrides.baseBranch ?? "main",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PR creation", () => {
  it("creates a PR with correct fields", () => {
    const pr = seedPr();

    expect(pr.title).toBe("My PR");
    expect(pr.description).toBe("A test PR");
    expect(pr.branch).toBe("feat/my-feature");
    expect(pr.baseBranch).toBe("main");
    expect(pr.status).toBe("pending");
    expect(pr.sessionId).toBe("sess-1");
    expect(pr.id).toBeTruthy();
  });

  it("defaults baseBranch to main when empty", () => {
    const pr = createPrRequest("sess-1", {
      title: "T",
      description: "D",
      branch: "feat/x",
      baseBranch: "",
    });

    expect(pr.baseBranch).toBe("main");
  });
});

describe("getPrDiff", () => {
  it("uses execFileSync with array args (not shell string)", () => {
    const pr = seedPr({ branch: "feat/test", baseBranch: "main" });
    mockExecFileSync.mockReturnValue("diff output");

    getPrDiff(pr.id);

    // Verify execFileSync is called (safe from injection), NOT execSync
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "docker",
      ["exec", "vivi-sandbox-sess-1", "git", "-C", "/workspace", "diff", "main...feat/test"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("handles branch names with special characters safely", () => {
    const pr = seedPr({ branch: "feat/$(whoami)", baseBranch: "main" });
    mockExecFileSync.mockReturnValue("");

    getPrDiff(pr.id);

    // The branch name is passed as a separate array element, not interpolated into a shell string
    const args = mockExecFileSync.mock.calls[0][1];
    expect(args).toContain("main...feat/$(whoami)");
    // Because it's an array arg, the shell never interprets $(whoami)
  });

  it("throws for unknown PR id", () => {
    expect(() => getPrDiff("nonexistent")).toThrow("PR request nonexistent not found");
  });
});

describe("getPrFile — path traversal prevention", () => {
  it("allows normal file paths", () => {
    const pr = seedPr();
    mockExecFileSync.mockReturnValue("file contents");

    const result = getPrFile(pr.id, "src/index.ts");

    expect(result).toBe("file contents");
  });

  it("allows nested paths", () => {
    const pr = seedPr();
    mockExecFileSync.mockReturnValue("nested");

    const result = getPrFile(pr.id, "src/components/App.tsx");

    expect(result).toBe("nested");
  });

  it("rejects path traversal with ..", () => {
    const pr = seedPr();

    expect(() => getPrFile(pr.id, "../../../etc/passwd")).toThrow("Invalid file path");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("rejects path traversal with encoded sequences that resolve outside /workspace", () => {
    const pr = seedPr();

    // path.resolve("/workspace", "foo/../../etc/passwd") = "/etc/passwd"
    expect(() => getPrFile(pr.id, "foo/../../etc/passwd")).toThrow("Invalid file path");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("rejects absolute paths", () => {
    const pr = seedPr();

    expect(() => getPrFile(pr.id, "/etc/passwd")).toThrow("Invalid file path");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("allows paths with .. that stay within /workspace", () => {
    const pr = seedPr();
    mockExecFileSync.mockReturnValue("ok");

    // /workspace/src/../lib/utils.ts resolves to /workspace/lib/utils.ts — still within bounds
    const result = getPrFile(pr.id, "src/../lib/utils.ts");

    expect(result).toBe("ok");
  });

  it("uses execFileSync (not shell) to fetch file content", () => {
    const pr = seedPr();
    mockExecFileSync.mockReturnValue("content");

    getPrFile(pr.id, "README.md");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["show", `${pr.branch}:README.md`]),
      expect.any(Object),
    );
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});
