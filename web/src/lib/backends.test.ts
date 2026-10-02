import { beforeEach, describe, expect, it, vi } from "vitest";

import { backendTimeoutMs, configuredBackends, resolveBackend } from "./backends";

describe("configured backends", () => {
  beforeEach(() => {
    vi.stubEnv("BACKENDS", "");
    vi.stubEnv("BACKEND_URL", "");
  });

  it("defaults to the Go backend on its local port", () => {
    expect(configuredBackends()).toEqual([{ name: "default", url: "http://localhost:24791" }]);
  });

  it("takes a single BACKEND_URL", () => {
    vi.stubEnv("BACKEND_URL", "http://go:24791");
    expect(configuredBackends()).toEqual([{ name: "default", url: "http://go:24791" }]);
  });

  it("takes a BACKENDS map, in order, over BACKEND_URL", () => {
    vi.stubEnv("BACKEND_URL", "http://ignored:24791");
    vi.stubEnv("BACKENDS", '{"go":"http://go:24791","python":"http://python:24792"}');
    expect(configuredBackends()).toEqual([
      { name: "go", url: "http://go:24791" },
      { name: "python", url: "http://python:24792" },
    ]);
  });

  it.each([
    ["not JSON", "go=http://go:24791"],
    ["an array", '["http://go:24791"]'],
    ["an empty map", "{}"],
    ["a non-http URL", '{"go":"file:///etc/passwd"}'],
    ["a URL that is not a string", '{"go":24791}'],
  ])("fails loudly when BACKENDS is %s", (_, value) => {
    vi.stubEnv("BACKENDS", value);
    expect(() => configuredBackends()).toThrow(/BACKENDS/);
  });
});

describe("resolveBackend", () => {
  beforeEach(() => {
    vi.stubEnv("BACKENDS", '{"go":"http://go:24791","python":"http://python:24792"}');
  });

  it("picks the first backend by default", () => {
    expect(resolveBackend()).toEqual({ name: "go", url: "http://go:24791" });
  });

  it("picks a backend by name", () => {
    expect(resolveBackend("python")).toEqual({ name: "python", url: "http://python:24792" });
  });

  it.each(["typescript", "http://169.254.169.254/latest", "http://python:24792", ""])(
    "knows nothing of %j: only configured names resolve",
    (name) => {
      expect(resolveBackend(name)).toBeUndefined();
    },
  );
});

describe("backendTimeoutMs", () => {
  it("leaves the backend's 30 s budget room to answer first", () => {
    vi.stubEnv("BACKEND_TIMEOUT_MS", "");
    expect(backendTimeoutMs()).toBe(35_000);
  });

  it("reads BACKEND_TIMEOUT_MS", () => {
    vi.stubEnv("BACKEND_TIMEOUT_MS", "5000");
    expect(backendTimeoutMs()).toBe(5000);
  });
});
