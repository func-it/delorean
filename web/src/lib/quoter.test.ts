import { beforeEach, describe, expect, it, vi } from "vitest";

import { configuredQuoter, quoterTimeoutMs } from "./quoter";

describe("the configured quoter", () => {
  beforeEach(() => {
    vi.stubEnv("QUOTER_URL", "");
  });

  it("defaults to the quoter on its local port", () => {
    expect(configuredQuoter()).toEqual({ name: "quoter", url: "http://localhost:24793" });
  });

  it("takes QUOTER_URL", () => {
    vi.stubEnv("QUOTER_URL", "http://quoter:24793");
    expect(configuredQuoter()).toEqual({ name: "quoter", url: "http://quoter:24793" });
  });

  it.each(["file:///etc/passwd", "not a url", "ftp://quoter:21"])("fails loudly when QUOTER_URL is %s", (value) => {
    vi.stubEnv("QUOTER_URL", value);
    expect(() => configuredQuoter()).toThrow(/QUOTER_URL/);
  });
});

describe("quoterTimeoutMs", () => {
  it("leaves the quoter's 15 s budget room to answer first", () => {
    vi.stubEnv("QUOTER_TIMEOUT_MS", "");
    expect(quoterTimeoutMs()).toBe(30_000);
  });

  it("reads QUOTER_TIMEOUT_MS", () => {
    vi.stubEnv("QUOTER_TIMEOUT_MS", "5000");
    expect(quoterTimeoutMs()).toBe(5000);
  });
});
