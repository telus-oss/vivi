import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PortForwards } from "./PortForwards";
import type { PortForward } from "../lib/types";

vi.mock("../lib/api", () => ({
  getOpenPorts: vi.fn(),
  closePort: vi.fn(),
  getConfig: vi.fn(),
  getPortForwardUrl: (pf: any) =>
    pf.proxyUrl || `http://localhost:${pf.hostPort}`,
}));

vi.mock("../lib/host", () => ({
  fetchHost: vi.fn().mockResolvedValue("localhost"),
  gitRemoteUrl: (host: string, port: number) => `git://${host}:${port}/`,
}));

import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

const basePorts: PortForward[] = [
  {
    sessionId: "s1",
    containerPort: 3000,
    hostPort: 19001,
    proxySubdomain: "p-3000-s1000000",
    proxyUrl: "http://p-3000-s1000000.localhost:7700",
    status: "active",
    createdAt: Date.now(),
    label: "Frontend Dev Server",
  },
];

const gitServerPort: PortForward = {
  sessionId: "s1",
  containerPort: 9418,
  hostPort: 19005,
  proxySubdomain: "p-9418-s1000000",
  proxyUrl: "http://p-9418-s1000000.localhost:7700",
  status: "active",
  createdAt: Date.now(),
  label: "Git Server",
  type: "git",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.getOpenPorts.mockResolvedValue(basePorts);
  mockedApi.closePort.mockResolvedValue({ ok: true });
});

describe("PortForwards", () => {
  it("renders port forwards after loading", async () => {
    render(<PortForwards sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByText("Frontend Dev Server")).toBeInTheDocument();
    });
    expect(screen.getByText(":3000")).toBeInTheDocument();
    expect(screen.getByText("p-3000-s1000000")).toBeInTheDocument();
  });

  it("shows empty state when no ports", async () => {
    mockedApi.getOpenPorts.mockResolvedValue([]);
    render(<PortForwards sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByText(/No ports forwarded/)).toBeInTheDocument();
    });
  });

  it("shows git remote command for Git Server ports", async () => {
    mockedApi.getOpenPorts.mockResolvedValue([gitServerPort]);
    render(<PortForwards sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByText("Git Server")).toBeInTheDocument();
    });
    expect(
      screen.getByText("git remote add sandbox git://localhost:19005/")
    ).toBeInTheDocument();
  });

  it("does not show git remote command for non-git ports", async () => {
    render(<PortForwards sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByText("Frontend Dev Server")).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/git remote add/)
    ).not.toBeInTheDocument();
  });

  it("shows git remote hint based on type field, not label", async () => {
    mockedApi.getOpenPorts.mockResolvedValue([
      {
        sessionId: "s1",
        containerPort: 9418,
        hostPort: 19010,
        proxySubdomain: "p-9418-s1000000",
        proxyUrl: "http://p-9418-s1000000.localhost:7700",
        status: "active" as const,
        createdAt: Date.now(),
        label: "My Custom Label",
        type: "git",
      },
    ]);
    render(<PortForwards sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByText("My Custom Label")).toBeInTheDocument();
    });
    expect(
      screen.getByText("git remote add sandbox git://localhost:19010/")
    ).toBeInTheDocument();
  });

  it("copies git remote command to clipboard", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    mockedApi.getOpenPorts.mockResolvedValue([gitServerPort]);
    render(<PortForwards sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByText("Git Server")).toBeInTheDocument();
    });

    const copyBtn = screen.getByTitle("Copy command");
    await user.click(copyBtn);

    expect(writeText).toHaveBeenCalledWith(
      "git remote add sandbox git://localhost:19005/"
    );

    vi.unstubAllGlobals();
  });

  it("shows container name when provided", async () => {
    mockedApi.getOpenPorts.mockResolvedValue([
      {
        ...basePorts[0],
        containerName: "myapp",
      },
    ]);
    render(<PortForwards sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByText("myapp:3000")).toBeInTheDocument();
    });
  });

  it("calls closePort when close button is clicked", async () => {
    const user = userEvent.setup();
    render(<PortForwards sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByText("Frontend Dev Server")).toBeInTheDocument();
    });

    const closeBtn = screen.getByTitle("Close port forward");
    await user.click(closeBtn);

    expect(mockedApi.closePort).toHaveBeenCalledWith("s1", 3000);
  });
});
