import { describe, it, expect } from "vitest";
import { getPortForwardUrl } from "./api";
import type { PortForward } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePf(overrides: Partial<PortForward> = {}): PortForward {
  return {
    sessionId: "s1",
    containerPort: 3000,
    hostPort: 19001,
    proxySubdomain: "p-3000-s1000000",
    proxyUrl: "http://p-3000-s1000000.localhost:5151",
    status: "active",
    createdAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getPortForwardUrl", () => {
  it("returns the proxyUrl for a normal http URL", () => {
    const pf = makePf({ proxyUrl: "http://p-3000-abc.localhost:5151" });

    expect(getPortForwardUrl(pf)).toBe("http://p-3000-abc.localhost:5151");
  });

  it("returns the proxyUrl for https", () => {
    const pf = makePf({ proxyUrl: "https://secure.example.com" });

    expect(getPortForwardUrl(pf)).toBe("https://secure.example.com");
  });

  it("falls back to localhost when proxyUrl is empty", () => {
    const pf = makePf({ proxyUrl: "", hostPort: 19005 });

    expect(getPortForwardUrl(pf)).toBe("http://127.0.0.1:19005");
  });

  it("falls back to localhost when proxyUrl is undefined", () => {
    const pf = makePf({ hostPort: 19010 });
    delete (pf as any).proxyUrl;

    expect(getPortForwardUrl(pf)).toBe("http://127.0.0.1:19010");
  });

  it("rejects javascript: protocol and falls back to localhost", () => {
    const pf = makePf({ proxyUrl: "javascript:alert(1)", hostPort: 19001 });

    expect(getPortForwardUrl(pf)).toBe("http://127.0.0.1:19001");
  });

  it("rejects data: protocol and falls back to localhost", () => {
    const pf = makePf({ proxyUrl: "data:text/html,<h1>hi</h1>", hostPort: 19002 });

    expect(getPortForwardUrl(pf)).toBe("http://127.0.0.1:19002");
  });

  it("rejects ftp: protocol and falls back to localhost", () => {
    const pf = makePf({ proxyUrl: "ftp://evil.com/file", hostPort: 19003 });

    expect(getPortForwardUrl(pf)).toBe("http://127.0.0.1:19003");
  });

  it("rejects malformed URLs and falls back to localhost", () => {
    const pf = makePf({ proxyUrl: "not a url at all", hostPort: 19004 });

    expect(getPortForwardUrl(pf)).toBe("http://127.0.0.1:19004");
  });

  it("rejects file: protocol and falls back to localhost", () => {
    const pf = makePf({ proxyUrl: "file:///etc/passwd", hostPort: 19005 });

    expect(getPortForwardUrl(pf)).toBe("http://127.0.0.1:19005");
  });
});
