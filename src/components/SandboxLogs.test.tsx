import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SandboxLogs } from "./SandboxLogs";

// Mock the api module
vi.mock("../lib/api", () => ({
  getSessionLogs: vi.fn(),
}));

import * as api from "../lib/api";
const mockGetSessionLogs = vi.mocked(api.getSessionLogs);

// Helper to find text inside a <pre> element (bypasses default whitespace normalization)
const findPreText = (container: HTMLElement, text: string) => {
  const pre = container.querySelector("pre");
  return pre?.textContent === text ? pre : null;
};

describe("SandboxLogs", () => {
  beforeEach(() => {
    mockGetSessionLogs.mockResolvedValue({ logs: "line 1\nline 2\nline 3" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders heading", async () => {
    render(<SandboxLogs sessionId="s1" />);
    expect(screen.getByText("Sandbox Logs")).toBeInTheDocument();
  });

  it("fetches and displays logs", async () => {
    const { container } = render(<SandboxLogs sessionId="s1" />);
    await waitFor(() => {
      expect(findPreText(container, "line 1\nline 2\nline 3")).toBeTruthy();
    });
    expect(mockGetSessionLogs).toHaveBeenCalledWith("s1", 200, "sandbox");
  });

  it("shows error state when fetch fails", async () => {
    mockGetSessionLogs.mockRejectedValue(new Error("Session not running"));
    render(<SandboxLogs sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Session not running")).toBeInTheDocument();
    });
  });

  it("shows loading state initially", () => {
    mockGetSessionLogs.mockReturnValue(new Promise(() => {})); // never resolves
    render(<SandboxLogs sessionId="s1" />);
    expect(screen.getByText("Loading logs...")).toBeInTheDocument();
  });

  it("refreshes logs on interval", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    try {
      render(<SandboxLogs sessionId="s1" />);

      // Flush the initial fetch promise
      await act(async () => {});

      const callsAfterMount = mockGetSessionLogs.mock.calls.length;

      // Advance past the 15s interval
      await act(async () => {
        vi.advanceTimersByTime(15001);
      });

      // Verify at least one additional call was made
      expect(mockGetSessionLogs.mock.calls.length).toBeGreaterThan(callsAfterMount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows changing tail line count", async () => {
    const user = userEvent.setup();
    render(<SandboxLogs sessionId="s1" />);

    await waitFor(() => {
      expect(mockGetSessionLogs).toHaveBeenCalledWith("s1", 200, "sandbox");
    });

    const select = screen.getByDisplayValue("200 lines");
    await user.selectOptions(select, "500");

    await waitFor(() => {
      expect(mockGetSessionLogs).toHaveBeenCalledWith("s1", 500, "sandbox");
    });
  });

  it("shows empty state when no logs", async () => {
    mockGetSessionLogs.mockResolvedValue({ logs: "" });
    render(<SandboxLogs sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("No logs available")).toBeInTheDocument();
    });
  });

  it("copy button triggers clipboard write and shows feedback", async () => {
    // userEvent.setup() installs its own clipboard stub — spy on it directly
    const user = userEvent.setup();
    const { container } = render(<SandboxLogs sessionId="s1" />);

    await waitFor(() => {
      expect(findPreText(container, "line 1\nline 2\nline 3")).toBeTruthy();
    });

    // Verify copy button is present
    const copyBtn = screen.getByTitle("Copy logs");
    expect(copyBtn).toBeInTheDocument();

    await user.click(copyBtn);

    // The userEvent clipboard captures the write; verify the logs are in the clipboard
    const clipboardText = await navigator.clipboard.readText();
    expect(clipboardText).toBe("line 1\nline 2\nline 3");
  });

  it("copy button shows error icon when clipboard write fails", async () => {
    const user = userEvent.setup();
    const { container } = render(<SandboxLogs sessionId="s1" />);

    await waitFor(() => {
      expect(findPreText(container, "line 1\nline 2\nline 3")).toBeTruthy();
    });

    // Make clipboard.writeText reject
    const origWriteText = navigator.clipboard.writeText;
    navigator.clipboard.writeText = vi.fn().mockRejectedValue(new Error("Clipboard permission denied"));

    const copyBtn = screen.getByTitle("Copy logs");
    await user.click(copyBtn);

    // Should show error icon (X), not success icon (Check)
    await waitFor(() => {
      // The X icon gets the text-red-400 class
      const errorIcon = copyBtn.querySelector(".text-red-400");
      expect(errorIcon).toBeInTheDocument();
    });

    // Restore
    navigator.clipboard.writeText = origWriteText;
  });
});
