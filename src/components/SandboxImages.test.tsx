import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SandboxImages } from "./SandboxImages";
import type { SandboxImage } from "../lib/types";

vi.mock("../lib/api", () => ({
  listSandboxImages: vi.fn(),
  addSandboxImage: vi.fn(),
  removeSandboxImage: vi.fn(),
  setSandboxImageDefault: vi.fn(),
}));

import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

const baseImages: SandboxImage[] = [
  { id: 1, name: "Default Image", image: "vivi-sandbox:latest", isDefault: true, createdAt: "2026-01-01" },
  { id: 2, name: "Custom Image", image: "my-sandbox:v2", isDefault: false, createdAt: "2026-01-02" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.listSandboxImages.mockResolvedValue(baseImages);
  mockedApi.addSandboxImage.mockResolvedValue({ id: 3, name: "New Image", image: "new-image:v1", isDefault: false, createdAt: "2026-01-03" });
  mockedApi.removeSandboxImage.mockResolvedValue({ ok: true });
  mockedApi.setSandboxImageDefault.mockResolvedValue({ id: 2, name: "Custom Image", image: "my-sandbox:v2", isDefault: true, createdAt: "2026-01-02" });
});

describe("SandboxImages", () => {
  it("renders images after loading - show name, image ref, default badge", async () => {
    render(<SandboxImages />);

    await waitFor(() => {
      expect(screen.getByText("Default Image")).toBeInTheDocument();
    });

    expect(screen.getByText("vivi-sandbox:latest")).toBeInTheDocument();
    expect(screen.getByText("Custom Image")).toBeInTheDocument();
    expect(screen.getByText("my-sandbox:v2")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
  });

  it("shows add form with placeholders", async () => {
    render(<SandboxImages />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Image name")).toBeInTheDocument();
    });

    expect(screen.getByPlaceholderText("Docker image reference")).toBeInTheDocument();
  });

  it("adds an image via the form", async () => {
    const user = userEvent.setup();
    render(<SandboxImages />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Image name")).toBeInTheDocument();
    });

    const nameInput = screen.getByPlaceholderText("Image name");
    const imageInput = screen.getByPlaceholderText("Docker image reference");

    await user.type(nameInput, "New Image");
    await user.type(imageInput, "new-image:v1");
    await user.type(imageInput, "{Enter}");

    await waitFor(() => {
      expect(mockedApi.addSandboxImage).toHaveBeenCalledWith("New Image", "new-image:v1");
    });
  });

  it("does not submit with empty fields", async () => {
    const user = userEvent.setup();
    render(<SandboxImages />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Image name")).toBeInTheDocument();
    });

    const nameInput = screen.getByPlaceholderText("Image name");
    await user.type(nameInput, "{Enter}");

    expect(mockedApi.addSandboxImage).not.toHaveBeenCalled();
  });

  it("removes a non-default image when delete clicked", async () => {
    const user = userEvent.setup();
    render(<SandboxImages />);

    await waitFor(() => {
      expect(screen.getByText("Custom Image")).toBeInTheDocument();
    });

    // Get all delete buttons (aria-label="Delete image"), the non-default one should be enabled
    const deleteButtons = screen.getAllByLabelText("Delete image");
    // First delete button is for Default Image (disabled), second for Custom Image (enabled)
    const enabledDeleteBtn = deleteButtons.find((btn) => !(btn as HTMLButtonElement).disabled);
    expect(enabledDeleteBtn).toBeTruthy();

    await user.click(enabledDeleteBtn!);

    await waitFor(() => {
      expect(mockedApi.removeSandboxImage).toHaveBeenCalledWith(2);
    });
  });

  it("sets default when 'Set Default' clicked", async () => {
    const user = userEvent.setup();
    render(<SandboxImages />);

    await waitFor(() => {
      expect(screen.getByText("Custom Image")).toBeInTheDocument();
    });

    // Get all "Set Default" buttons; the one for Custom Image should be enabled
    const setDefaultButtons = screen.getAllByRole("button", { name: "Set Default" });
    const enabledSetDefault = setDefaultButtons.find((btn) => !(btn as HTMLButtonElement).disabled);
    expect(enabledSetDefault).toBeTruthy();

    await user.click(enabledSetDefault!);

    await waitFor(() => {
      expect(mockedApi.setSandboxImageDefault).toHaveBeenCalledWith(2);
    });
  });

  it("shows error message when add fails", async () => {
    const user = userEvent.setup();
    mockedApi.addSandboxImage.mockRejectedValue(new Error("Image already exists"));
    render(<SandboxImages />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Image name")).toBeInTheDocument();
    });

    const nameInput = screen.getByPlaceholderText("Image name");
    const imageInput = screen.getByPlaceholderText("Docker image reference");

    await user.type(nameInput, "Bad Image");
    await user.type(imageInput, "bad-image:latest");
    await user.type(imageInput, "{Enter}");

    await waitFor(() => {
      expect(screen.getByText("Image already exists")).toBeInTheDocument();
    });
  });

  it("delete button disabled for default image", async () => {
    render(<SandboxImages />);

    await waitFor(() => {
      expect(screen.getByText("Default Image")).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByLabelText("Delete image");
    // The first delete button should be for Default Image and be disabled
    const defaultDeleteBtn = deleteButtons[0];
    expect(defaultDeleteBtn).toBeDisabled();
  });
});
