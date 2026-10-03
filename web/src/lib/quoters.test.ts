import { beforeEach, describe, expect, it, vi } from "vitest";

import { configuredQuoters, quoterTimeoutMs, resolveQuoter } from "./quoters";

describe("configured quoters", () => {
  beforeEach(() => {
    vi.stubEnv("QUOTERS", "");
    vi.stubEnv("QUOTER_URL", "");
  });

  it("defaults to the Go quoter on its local port", () => {
    expect(configuredQuoters()).toEqual([{ name: "default", url: "http://localhost:24791" }]);
  });

  it("takes a single QUOTER_URL", () => {
    vi.stubEnv("QUOTER_URL", "http://go:24791");
    expect(configuredQuoters()).toEqual([{ name: "default", url: "http://go:24791" }]);
  });

  it("takes a QUOTERS map, in order, over QUOTER_URL", () => {
    vi.stubEnv("QUOTER_URL", "http://ignored:24791");
    vi.stubEnv("QUOTERS", '{"go":"http://go:24791","python":"http://python:24792"}');
    expect(configuredQuoters()).toEqual([
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
  ])("fails loudly when QUOTERS is %s", (_, value) => {
    vi.stubEnv("QUOTERS", value);
    expect(() => configuredQuoters()).toThrow(/QUOTERS/);
  });
});

describe("resolveQuoter", () => {
  beforeEach(() => {
    vi.stubEnv("QUOTERS", '{"go":"http://go:24791","python":"http://python:24792"}');
  });

  it("picks the first quoter by default", () => {
    expect(resolveQuoter()).toEqual({ name: "go", url: "http://go:24791" });
  });

  it("picks a quoter by name", () => {
    expect(resolveQuoter("python")).toEqual({ name: "python", url: "http://python:24792" });
  });

  it.each(["typescript", "http://169.254.169.254/latest", "http://python:24792", ""])(
    "knows nothing of %j: only configured names resolve",
    (name) => {
      expect(resolveQuoter(name)).toBeUndefined();
    },
  );
});

describe("quoterTimeoutMs", () => {
  it("leaves the quoter's 30 s budget room to answer first", () => {
    vi.stubEnv("QUOTER_TIMEOUT_MS", "");
    expect(quoterTimeoutMs()).toBe(35_000);
  });

  it("reads QUOTER_TIMEOUT_MS", () => {
    vi.stubEnv("QUOTER_TIMEOUT_MS", "5000");
    expect(quoterTimeoutMs()).toBe(5000);
  });
});
