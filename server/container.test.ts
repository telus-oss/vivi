import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const { mockExecSync, mockExecFileSync, mockExistsSync, mockMkdirSync, mockRmSync, mockWriteFileSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockExistsSync: vi.fn().mockReturnValue(true),
  mockMkdirSync: vi.fn(),
  mockRmSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

const mockStmt = vi.hoisted(() => ({
  all: vi.fn().mockReturnValue([]),
  get: vi.fn(),
  run: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const mod = { execSync: mockExecSync, execFileSync: mockExecFileSync };
  return { ...mod, default: mod };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: mockExistsSync,
      mkdirSync: mockMkdirSync,
      rmSync: mockRmSync,
      writeFileSync: mockWriteFileSync,
    },
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    rmSync: mockRmSync,
    writeFileSync: mockWriteFileSync,
  };
});

vi.mock("./db.js", () => ({
  default: {
    prepare: vi.fn(() => mockStmt),
  },
}));

vi.mock("./secrets.js", () => ({
  getSandboxEnv: vi.fn(() => ({})),
}));

vi.mock("./docker-namespace-proxy.js", () => ({
  startSessionProxy: vi.fn(async () => ({ mode: "socket", socketPath: "/tmp/test.sock" })),
  stopSessionProxy: vi.fn(),
  cleanupSessionContainers: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  runtime: { bin: "docker", composeBin: "docker compose" },
}));

vi.mock("./sandbox-images.js", () => ({
  getDefault: vi.fn(() => ({ id: 1, image: "vivi-sandbox", name: "default", isDefault: true })),
  getById: vi.fn(),
}));

vi.mock("./profiles.js", () => ({
  getProfileDir: vi.fn(),
  markProfileUsed: vi.fn(),
  getProfile: vi.fn(),
  saveProfileFromContainer: vi.fn(),
}));

vi.mock("./ports.js", () => ({
  closeAllPorts: vi.fn(),
}));

// Import after mocks
import { getSessions, getSession, getContainerName, startSession } from "./container.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
});

describe("session management basics", () => {
  it("starts with no sessions", () => {
    expect(getSessions()).toEqual([]);
  });

  it("getSession returns undefined for unknown id", () => {
    expect(getSession("nonexistent")).toBeUndefined();
  });

  it("getContainerName produces consistent names", () => {
    expect(getContainerName("abc123")).toBe("vivi-sandbox-abc123");
  });
});

describe("session ID generation", () => {
  it("generates IDs with 12 characters (from UUID slice)", () => {
    // Verify the slicing approach gives us 12 chars
    const { randomUUID } = require("node:crypto");
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = randomUUID().slice(0, 12);
      expect(id.length).toBe(12);
      ids.add(id);
    }
    // All 100 should be unique (collision at 12 chars is astronomically unlikely)
    expect(ids.size).toBe(100);
  });
});

describe("startSession validation", () => {
  it("requires repoPath when not attaching", async () => {
    await expect(startSession({})).rejects.toThrow("repoPath is required");
  });

  it("rejects non-existent paths", async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(startSession({ repoPath: "/nonexistent/path" })).rejects.toThrow(
      "Path not found"
    );
  });

  it("rejects paths without a .git directory", async () => {
    mockExistsSync.mockImplementation((p: string) => {
      // The repoPath exists, but repoPath/.git does not
      return !String(p).endsWith(".git");
    });

    await expect(startSession({ repoPath: "/some/folder" })).rejects.toThrow(
      "Not a git repository"
    );
  });
});
