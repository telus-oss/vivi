import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks — must be hoisted before any imports of the module under
// test so that the prepared statements and transaction created at import time
// use the mocked db.
// ---------------------------------------------------------------------------

// vi.hoisted runs before vi.mock factories, making these mocks available inside
// the mock factory closures despite vi.mock being hoisted to the top of the file.
const { mockStmt, mockExecFileSync } = vi.hoisted(() => {
  const mockStmt = {
    all: vi.fn(),
    get: vi.fn(),
    run: vi.fn(),
  };
  const mockExecFileSync = vi.fn();
  return { mockStmt, mockExecFileSync };
});

// db mock — prepare() always returns the same mockStmt so every statement
// reference in `stmts` uses the same spy handles we can reconfigure per test.
vi.mock("./db.js", () => ({
  default: {
    prepare: vi.fn(() => mockStmt),
    transaction: vi.fn((fn: (...args: unknown[]) => unknown) => fn),
  },
}));

vi.mock("node:child_process", () => {
  const mod = {
    execFileSync: mockExecFileSync,
  };
  return { ...mod, default: mod };
});

// ---------------------------------------------------------------------------
// Import after mocks are in place.
// ---------------------------------------------------------------------------
import { listImages, addImage, removeImage, setDefault, getDefault } from "./sandbox-images.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<{
  id: number;
  name: string;
  image: string;
  is_default: number;
  created_at: string;
}> = {}) {
  return {
    id: 1,
    name: "default-image",
    image: "ubuntu:22.04",
    is_default: 1,
    created_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
});

describe("listImages", () => {
  it("returns an empty array when there are no rows", () => {
    mockStmt.all.mockReturnValue([]);

    const result = listImages();

    expect(result).toEqual([]);
  });

  it("maps database rows to SandboxImage objects", () => {
    const row1 = makeRow({ id: 1, name: "base", image: "ubuntu:22.04", is_default: 1, created_at: "2024-01-01T00:00:00.000Z" });
    const row2 = makeRow({ id: 2, name: "node", image: "node:20", is_default: 0, created_at: "2024-02-01T00:00:00.000Z" });
    mockStmt.all.mockReturnValue([row1, row2]);

    const result = listImages();

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 1,
      name: "base",
      image: "ubuntu:22.04",
      isDefault: true,
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    expect(result[1]).toEqual({
      id: 2,
      name: "node",
      image: "node:20",
      isDefault: false,
      createdAt: "2024-02-01T00:00:00.000Z",
    });
  });

  it("maps is_default = 0 to isDefault: false", () => {
    mockStmt.all.mockReturnValue([makeRow({ is_default: 0 })]);

    const [img] = listImages();

    expect(img.isDefault).toBe(false);
  });
});

describe("addImage", () => {
  it("validates the image name and rejects invalid characters", () => {
    expect(() => addImage("my image", "; rm -rf /")).toThrow(
      "Invalid Docker image name"
    );
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("rejects image names with spaces", () => {
    expect(() => addImage("test", "ubuntu 22.04")).toThrow("Invalid Docker image name");
  });

  it("rejects command injection via semicolons", () => {
    expect(() => addImage("test", "ubuntu;rm -rf /")).toThrow("Invalid Docker image name");
  });

  it("rejects image names with shell special characters", () => {
    expect(() => addImage("test", "ubuntu$(whoami)")).toThrow("Invalid Docker image name");
  });

  it("throws when docker inspect fails (image not found locally)", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("non-zero exit code");
    });

    expect(() => addImage("my-image", "ubuntu:22.04")).toThrow(
      "Docker image 'ubuntu:22.04' not found locally"
    );
  });

  it("calls docker image inspect with the image name", () => {
    mockExecFileSync.mockReturnValue(Buffer.from(""));
    const insertedRow = makeRow({ id: 42, name: "my-image", image: "ubuntu:22.04", is_default: 0 });
    mockStmt.run.mockReturnValue({ lastInsertRowid: 42 });
    mockStmt.get.mockReturnValue(insertedRow);

    addImage("my-image", "ubuntu:22.04");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "docker",
      ["image", "inspect", "ubuntu:22.04"],
      expect.objectContaining({ stdio: "pipe", timeout: 5_000 })
    );
  });

  it("inserts the image and returns the mapped row", () => {
    mockExecFileSync.mockReturnValue(Buffer.from(""));
    const insertedRow = makeRow({ id: 5, name: "my-image", image: "node:20-alpine", is_default: 0, created_at: "2024-03-01T00:00:00.000Z" });
    mockStmt.run.mockReturnValue({ lastInsertRowid: 5 });
    mockStmt.get.mockReturnValue(insertedRow);

    const result = addImage("my-image", "node:20-alpine");

    expect(mockStmt.run).toHaveBeenCalledWith("my-image", "node:20-alpine");
    expect(result).toEqual({
      id: 5,
      name: "my-image",
      image: "node:20-alpine",
      isDefault: false,
      createdAt: "2024-03-01T00:00:00.000Z",
    });
  });

  it("accepts valid image names with colons, slashes, and dots", () => {
    mockExecFileSync.mockReturnValue(Buffer.from(""));
    const row = makeRow({ id: 1, name: "test", image: "registry.example.com/org/image:v1.2.3", is_default: 0 });
    mockStmt.run.mockReturnValue({ lastInsertRowid: 1 });
    mockStmt.get.mockReturnValue(row);

    expect(() => addImage("test", "registry.example.com/org/image:v1.2.3")).not.toThrow();
  });

  it("rejects empty display names", () => {
    expect(() => addImage("", "ubuntu:22.04")).toThrow("Display name must not be empty");
  });

  it("rejects display names longer than 100 characters", () => {
    const longName = "a".repeat(101);
    expect(() => addImage(longName, "ubuntu:22.04")).toThrow(
      "Display name must be at most 100 characters (got 101)"
    );
  });

  it("rejects display names with control characters", () => {
    expect(() => addImage("my-image\x00", "ubuntu:22.04")).toThrow(
      "Display name contains invalid characters"
    );
    expect(() => addImage("my\nimage", "ubuntu:22.04")).toThrow(
      "Display name contains invalid characters"
    );
  });

  it("accepts display names with spaces and printable ASCII", () => {
    mockExecFileSync.mockReturnValue(Buffer.from(""));
    const row = makeRow({ id: 1, name: "My Ubuntu Image (v2)", image: "ubuntu:22.04", is_default: 0 });
    mockStmt.run.mockReturnValue({ lastInsertRowid: 1 });
    mockStmt.get.mockReturnValue(row);

    expect(() => addImage("My Ubuntu Image (v2)", "ubuntu:22.04")).not.toThrow();
  });

  it("rejects empty image references", () => {
    expect(() => addImage("test", "")).toThrow("Docker image reference must not be empty");
  });

  it("rejects image references longer than 256 characters", () => {
    const longImage = "a".repeat(257);
    expect(() => addImage("test", longImage)).toThrow(
      "Docker image reference must be at most 256 characters (got 257)"
    );
  });

  it("throws when the inserted row cannot be retrieved", () => {
    mockExecFileSync.mockReturnValue(Buffer.from(""));
    mockStmt.run.mockReturnValue({ lastInsertRowid: 99 });
    mockStmt.get.mockReturnValue(undefined);

    expect(() => addImage("orphan", "ubuntu:22.04")).toThrow(
      "Failed to retrieve inserted sandbox image with id 99"
    );
  });
});

describe("removeImage", () => {
  it("throws when the image is not found", () => {
    mockStmt.get.mockReturnValue(undefined);

    expect(() => removeImage(999)).toThrow("Sandbox image with id 999 not found");
  });

  it("throws when trying to remove the default image", () => {
    mockStmt.get.mockReturnValue(makeRow({ id: 1, is_default: 1 }));

    expect(() => removeImage(1)).toThrow(
      "Cannot remove sandbox image 'default-image' (id 1) because it is the default"
    );
  });

  it("throws when trying to remove the last remaining image", () => {
    // First .get() call: getById (non-default row)
    // Second .get() call: countAll — returns count of 1
    let getCallCount = 0;
    mockStmt.get.mockImplementation(() => {
      getCallCount++;
      if (getCallCount === 1) return makeRow({ id: 2, is_default: 0 });
      return { count: 1 };
    });

    expect(() => removeImage(2)).toThrow(
      "Cannot remove the last remaining sandbox image (id 2)"
    );
    expect(mockStmt.run).not.toHaveBeenCalled();
  });

  it("deletes the image when it is valid (non-default, not the last)", () => {
    let getCallCount = 0;
    mockStmt.get.mockImplementation(() => {
      getCallCount++;
      if (getCallCount === 1) return makeRow({ id: 3, name: "extra", is_default: 0 });
      return { count: 3 };
    });

    removeImage(3);

    expect(mockStmt.run).toHaveBeenCalledWith(3);
  });
});

describe("setDefault", () => {
  it("throws when the image is not found", () => {
    mockStmt.get.mockReturnValue(undefined);

    expect(() => setDefault(77)).toThrow("Sandbox image with id 77 not found");
  });

  it("calls the transaction and returns the updated row", () => {
    const originalRow = makeRow({ id: 2, name: "node", image: "node:20", is_default: 0 });
    const updatedRow = makeRow({ id: 2, name: "node", image: "node:20", is_default: 1 });

    let getCallCount = 0;
    mockStmt.get.mockImplementation(() => {
      getCallCount++;
      if (getCallCount === 1) return originalRow; // existence check
      return updatedRow; // post-transaction fetch
    });

    const result = setDefault(2);

    expect(result).toEqual({
      id: 2,
      name: "node",
      image: "node:20",
      isDefault: true,
      createdAt: "2024-01-01T00:00:00.000Z",
    });
  });

  it("throws when the updated row cannot be retrieved after transaction", () => {
    let getCallCount = 0;
    mockStmt.get.mockImplementation(() => {
      getCallCount++;
      if (getCallCount === 1) return makeRow({ id: 4, is_default: 0 }); // existence check
      return undefined; // post-transaction fetch fails
    });

    expect(() => setDefault(4)).toThrow(
      "Failed to retrieve sandbox image with id 4 after setting as default"
    );
  });
});

describe("getDefault", () => {
  it("returns the default image when one is configured", () => {
    const row = makeRow({ id: 1, name: "base", image: "ubuntu:22.04", is_default: 1, created_at: "2024-01-01T00:00:00.000Z" });
    mockStmt.get.mockReturnValue(row);

    const result = getDefault();

    expect(result).toEqual({
      id: 1,
      name: "base",
      image: "ubuntu:22.04",
      isDefault: true,
      createdAt: "2024-01-01T00:00:00.000Z",
    });
  });

  it("throws when no default image is configured", () => {
    mockStmt.get.mockReturnValue(undefined);

    expect(() => getDefault()).toThrow("No default sandbox image is configured");
  });
});
