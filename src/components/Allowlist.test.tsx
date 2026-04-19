import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Allowlist } from "./Allowlist";
import type { AllowlistConfig } from "../lib/types";

vi.mock("../lib/api", () => ({
  getAllowlist: vi.fn(),
  addNetworkRule: vi.fn(),
  removeNetworkRule: vi.fn(),
  setAllowlistEnabled: vi.fn(),
  updateNetworkRule: vi.fn(),
}));

import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

const baseConfig: AllowlistConfig = {
  enabled: true,
  network: [
    { id: "r1", pattern: "*.github.com", description: "GitHub" },
    { id: "r2", pattern: "registry.npmjs.org" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.getAllowlist.mockResolvedValue(baseConfig);
  mockedApi.addNetworkRule.mockResolvedValue({ id: "r3", pattern: "new.host" });
  mockedApi.removeNetworkRule.mockResolvedValue({ ok: true });
  mockedApi.setAllowlistEnabled.mockResolvedValue({ ok: true });
  mockedApi.updateNetworkRule.mockResolvedValue({ id: "r1", pattern: "updated.com", description: "Updated" });
});

describe("Allowlist", () => {
  it("renders network rules after loading", async () => {
    render(<Allowlist />);

    await waitFor(() => {
      expect(screen.getByText("*.github.com")).toBeInTheDocument();
    });
    expect(screen.getByText("registry.npmjs.org")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  it("shows enabled state text", async () => {
    render(<Allowlist />);

    await waitFor(() => {
      expect(screen.getByText("Network filtering active")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument();
  });

  it("shows disabled state text when filtering is off", async () => {
    mockedApi.getAllowlist.mockResolvedValue({ ...baseConfig, enabled: false });
    render(<Allowlist />);

    await waitFor(() => {
      expect(screen.getByText("Network filtering disabled")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
  });

  it("toggles enabled state on button click", async () => {
    const user = userEvent.setup();
    mockedApi.getAllowlist
      .mockResolvedValueOnce(baseConfig)
      .mockResolvedValueOnce({ ...baseConfig, enabled: false });

    render(<Allowlist />);

    await waitFor(() => {
      expect(screen.getByText("Network filtering active")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Disable" }));

    expect(mockedApi.setAllowlistEnabled).toHaveBeenCalledWith(false);
  });

  it("adds a network rule via the form", async () => {
    const user = userEvent.setup();
    render(<Allowlist />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("*.example.com")).toBeInTheDocument();
    });

    const patternInput = screen.getByPlaceholderText("*.example.com");
    const descInput = screen.getByPlaceholderText("Description (optional)");

    await user.type(patternInput, "api.openai.com");
    await user.type(descInput, "OpenAI API");
    // Submit the form by pressing Enter in the pattern input
    await user.type(patternInput, "{Enter}");

    await waitFor(() => {
      expect(mockedApi.addNetworkRule).toHaveBeenCalledWith("api.openai.com", "OpenAI API");
    });
  });

  it("does not submit empty pattern", async () => {
    const user = userEvent.setup();
    render(<Allowlist />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("*.example.com")).toBeInTheDocument();
    });

    // Submit with empty input via Enter
    const patternInput = screen.getByPlaceholderText("*.example.com");
    await user.type(patternInput, "{Enter}");

    expect(mockedApi.addNetworkRule).not.toHaveBeenCalled();
  });

  it("removes a network rule when delete is clicked", async () => {
    const user = userEvent.setup();
    render(<Allowlist />);

    await waitFor(() => {
      expect(screen.getByText("*.github.com")).toBeInTheDocument();
    });

    // Find the rule row containing *.github.com, then find the delete button (second button, after edit)
    const ruleRow = screen.getByText("*.github.com").closest("div[class*='flex items-center justify-between']")!;
    const deleteBtn = within(ruleRow).getAllByRole("button")[1];

    await user.click(deleteBtn);

    await waitFor(() => {
      expect(mockedApi.removeNetworkRule).toHaveBeenCalledWith("r1");
    });
  });

  it("enters edit mode when edit button is clicked", async () => {
    const user = userEvent.setup();
    render(<Allowlist />);

    await waitFor(() => {
      expect(screen.getByText("*.github.com")).toBeInTheDocument();
    });

    const editButtons = screen.getAllByLabelText("Edit");
    await user.click(editButtons[0]);

    // Should show input fields pre-filled with the rule values
    const inputs = screen.getAllByRole("textbox");
    const patternInput = inputs.find((input) => (input as HTMLInputElement).value === "*.github.com");
    expect(patternInput).toBeInTheDocument();
  });

  it("cancels edit mode without saving", async () => {
    const user = userEvent.setup();
    render(<Allowlist />);

    await waitFor(() => {
      expect(screen.getByText("*.github.com")).toBeInTheDocument();
    });

    const editButtons = screen.getAllByLabelText("Edit");
    await user.click(editButtons[0]);

    const cancelBtn = screen.getByLabelText("Cancel");
    await user.click(cancelBtn);

    expect(mockedApi.updateNetworkRule).not.toHaveBeenCalled();
    expect(screen.getByText("*.github.com")).toBeInTheDocument();
  });

  it("saves edited rule on save button click", async () => {
    const user = userEvent.setup();
    mockedApi.getAllowlist
      .mockResolvedValueOnce(baseConfig)
      .mockResolvedValueOnce({
        ...baseConfig,
        network: [
          { id: "r1", pattern: "updated.github.com", description: "Updated GitHub" },
          { id: "r2", pattern: "registry.npmjs.org" },
        ],
      });

    render(<Allowlist />);

    await waitFor(() => {
      expect(screen.getByText("*.github.com")).toBeInTheDocument();
    });

    const editButtons = screen.getAllByLabelText("Edit");
    await user.click(editButtons[0]);

    // Find the pattern input in edit mode and clear + type new value
    const inputs = screen.getAllByRole("textbox");
    const patternInput = inputs.find((input) => (input as HTMLInputElement).value === "*.github.com")!;
    const descInput = inputs.find((input) => (input as HTMLInputElement).value === "GitHub")!;

    await user.clear(patternInput);
    await user.type(patternInput, "updated.github.com");
    await user.clear(descInput);
    await user.type(descInput, "Updated GitHub");

    const saveBtn = screen.getByLabelText("Save");
    await user.click(saveBtn);

    await waitFor(() => {
      expect(mockedApi.updateNetworkRule).toHaveBeenCalledWith("r1", "updated.github.com", "Updated GitHub");
    });
  });
});
