import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SecretManager } from "./SecretManager";
import type { SecretPublic } from "../lib/types";

vi.mock("../lib/api", () => ({
  listSecrets: vi.fn(),
  addSecret: vi.fn(),
  removeSecret: vi.fn(),
  updateSecret: vi.fn(),
}));

import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

const baseSecrets: SecretPublic[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    envVar: "CLAUDE_CODE_OAUTH_TOKEN",
    baseUrl: "https://api.anthropic.com",
    headerName: "x-api-key",
    createdAt: "2024-01-01T00:00:00Z",
    sandboxKey: "sk-sandbox-anthropic",
    sandboxBaseUrl: "https://api.anthropic.com",
  },
  {
    id: "openai",
    name: "OpenAI",
    envVar: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com",
    headerName: "authorization",
    createdAt: "2024-01-02T00:00:00Z",
    sandboxKey: "sk-sandbox-openai",
    sandboxBaseUrl: "https://api.openai.com",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.listSecrets.mockResolvedValue(baseSecrets);
  mockedApi.addSecret.mockResolvedValue(baseSecrets[0]);
  mockedApi.removeSecret.mockResolvedValue({ ok: true });
  mockedApi.updateSecret.mockResolvedValue(baseSecrets[0]);
});

describe("SecretManager", () => {
  it("renders secrets after loading", async () => {
    render(<SecretManager />);

    await waitFor(() => {
      expect(screen.getByText("Anthropic")).toBeInTheDocument();
    });
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
  });

  it("shows empty state when no secrets", async () => {
    mockedApi.listSecrets.mockResolvedValue([]);
    render(<SecretManager />);

    await waitFor(() => {
      expect(screen.getByText(/No secrets registered/)).toBeInTheDocument();
    });
  });

  it("opens add form when Add Secret is clicked", async () => {
    const user = userEvent.setup();
    render(<SecretManager />);

    await waitFor(() => {
      expect(screen.getByText("Anthropic")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Add Secret/ }));

    expect(screen.getByText("Save Secret")).toBeInTheDocument();
  });

  it("submits add form and calls addSecret", async () => {
    const user = userEvent.setup();
    mockedApi.listSecrets.mockResolvedValue([]);
    render(<SecretManager />);

    await waitFor(() => {
      expect(screen.getByText(/No secrets registered/)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Add Secret/ }));

    const nameInput = screen.getByPlaceholderText("e.g. Anthropic");
    await user.clear(nameInput);
    await user.type(nameInput, "Test Secret");

    const keyInput = screen.getByPlaceholderText("sk-ant-...");
    await user.type(keyInput, "sk-test-123");

    await user.click(screen.getByText("Save Secret"));

    await waitFor(() => {
      expect(mockedApi.addSecret).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Test Secret",
          key: "sk-test-123",
        }),
      );
    });
  });

  it("removes a secret when delete is clicked", async () => {
    const user = userEvent.setup();
    render(<SecretManager />);

    await waitFor(() => {
      expect(screen.getByText("Anthropic")).toBeInTheDocument();
    });

    // Find the Anthropic row and click its delete button
    const anthropicRow = screen.getByText("Anthropic").closest("div[class*='flex items-center justify-between']")!;
    const buttons = within(anthropicRow).getAllByRole("button");
    // Delete button is the last one (after edit)
    const deleteBtn = buttons[buttons.length - 1];
    await user.click(deleteBtn);

    await waitFor(() => {
      expect(mockedApi.removeSecret).toHaveBeenCalledWith("anthropic");
    });
  });

  it("opens edit form when edit button is clicked", async () => {
    const user = userEvent.setup();
    render(<SecretManager />);

    await waitFor(() => {
      expect(screen.getByText("Anthropic")).toBeInTheDocument();
    });

    // Click edit button (the one with title="Edit secret")
    const editBtn = screen.getAllByTitle("Edit secret")[0];
    await user.click(editBtn);

    // Edit form should show with pre-populated values
    await waitFor(() => {
      expect(screen.getByText("Save Changes")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("Anthropic")).toBeInTheDocument();
    expect(screen.getByDisplayValue("CLAUDE_CODE_OAUTH_TOKEN")).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://api.anthropic.com")).toBeInTheDocument();
    // Key field should be empty (user must re-enter)
    expect(screen.getByPlaceholderText("Leave empty to keep current key")).toHaveValue("");
  });

  it("submits edit form and calls updateSecret", async () => {
    const user = userEvent.setup();
    render(<SecretManager />);

    await waitFor(() => {
      expect(screen.getByText("Anthropic")).toBeInTheDocument();
    });

    // Click edit on Anthropic secret
    const editBtn = screen.getAllByTitle("Edit secret")[0];
    await user.click(editBtn);

    await waitFor(() => {
      expect(screen.getByText("Save Changes")).toBeInTheDocument();
    });

    // Change the name
    const nameInput = screen.getByDisplayValue("Anthropic");
    await user.clear(nameInput);
    await user.type(nameInput, "Anthropic Updated");

    await user.click(screen.getByText("Save Changes"));

    await waitFor(() => {
      expect(mockedApi.updateSecret).toHaveBeenCalledWith(
        "anthropic",
        expect.objectContaining({
          name: "Anthropic Updated",
          key: "",
        }),
      );
    });
  });

  it("cancels edit form and returns to normal view", async () => {
    const user = userEvent.setup();
    render(<SecretManager />);

    await waitFor(() => {
      expect(screen.getByText("Anthropic")).toBeInTheDocument();
    });

    // Click edit
    const editBtn = screen.getAllByTitle("Edit secret")[0];
    await user.click(editBtn);

    await waitFor(() => {
      expect(screen.getByText("Save Changes")).toBeInTheDocument();
    });

    // Click cancel
    await user.click(screen.getByText("Cancel"));

    // Should be back to normal view
    await waitFor(() => {
      expect(screen.queryByText("Save Changes")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
  });

  it("shows error when removeSecret fails", async () => {
    const user = userEvent.setup();
    mockedApi.removeSecret.mockRejectedValueOnce(new Error("Failed to delete secret"));
    render(<SecretManager />);

    await waitFor(() => {
      expect(screen.getByText("Anthropic")).toBeInTheDocument();
    });

    const anthropicRow = screen.getByText("Anthropic").closest("div[class*='flex items-center justify-between']")!;
    const buttons = within(anthropicRow).getAllByRole("button");
    const deleteBtn = buttons[buttons.length - 1];
    await user.click(deleteBtn);

    await waitFor(() => {
      expect(screen.getByText("Failed to delete secret")).toBeInTheDocument();
    });
  });

  it("shows edit form label for key field", async () => {
    const user = userEvent.setup();
    render(<SecretManager />);

    await waitFor(() => {
      expect(screen.getByText("Anthropic")).toBeInTheDocument();
    });

    const editBtn = screen.getAllByTitle("Edit secret")[0];
    await user.click(editBtn);

    await waitFor(() => {
      expect(screen.getByText("API Key (leave empty to keep current)")).toBeInTheDocument();
    });
  });
});
