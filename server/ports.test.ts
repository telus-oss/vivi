import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { makeProxyUrl, setServerPort } from "./proxyUrl";

setServerPort(5151);

const ORIGINAL_ENV = { ...process.env };

describe("makeProxyUrl", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PUBLIC_PORT_URL_BASE;
    delete process.env.HOST;
    delete process.env.PORT;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test("defaults to http://{sub}.{HOST}:{PORT} when no env base is set", () => {
    process.env.HOST = "localhost";
    expect(makeProxyUrl("p-3000-abc12345")).toBe("http://p-3000-abc12345.localhost:5151");
  });

  test("prepends subdomain onto PUBLIC_PORT_URL_BASE hostname", () => {
    process.env.PUBLIC_PORT_URL_BASE = "https://friendzi.xyz";
    expect(makeProxyUrl("p-3000-abc12345")).toBe("https://p-3000-abc12345.friendzi.xyz");
  });

  test("preserves port and path from PUBLIC_PORT_URL_BASE", () => {
    process.env.PUBLIC_PORT_URL_BASE = "https://example.com:8443/forward/";
    expect(makeProxyUrl("p-8080-deadbeef")).toBe("https://p-8080-deadbeef.example.com:8443/forward");
  });

  test("invalid PUBLIC_PORT_URL_BASE falls back without throwing", () => {
    process.env.PUBLIC_PORT_URL_BASE = "not a url";
    process.env.HOST = "localhost";
    expect(() => makeProxyUrl("p-3000-abc12345")).not.toThrow();
    expect(makeProxyUrl("p-3000-abc12345")).toBe("http://p-3000-abc12345.localhost:5151");
  });
});
