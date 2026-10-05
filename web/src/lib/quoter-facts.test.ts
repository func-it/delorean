import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { catalog } from "@/test/fixtures";

import { quoterFacts } from "./quoter-facts";

const health = (engines: "live" | "fake") => ({
  status: "ok",
  implementation: "typescript",
  version: "dev",
  engines,
  tracing: false,
  prompts: { guard: "a", parse: "b", identify: "c", judge: "d" },
});

/** Stands in for the quoter: what each path answers, or that nothing answers. */
function stubQuoter(answers: Record<string, () => Response>) {
  const quoter = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    const answer = answers[path];
    if (!answer) throw new TypeError("fetch failed");
    return answer();
  });
  vi.stubGlobal("fetch", quoter);
  return quoter;
}

describe("quoterFacts", () => {
  beforeEach(() => {
    vi.stubEnv("QUOTER_URL", "http://quoter.test");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("learns the engines and the catalog from the quoter, asked at its own address", async () => {
    const quoter = stubQuoter({ "/healthz": () => Response.json(health("fake")), "/v1/catalog": () => Response.json(catalog) });

    expect(await quoterFacts()).toEqual({ engines: "fake", catalog });
    expect(quoter.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input)).sort()).toEqual([
      "http://quoter.test/healthz",
      "http://quoter.test/v1/catalog",
    ]);
  });

  it("knows the real models too", async () => {
    stubQuoter({ "/healthz": () => Response.json(health("live")), "/v1/catalog": () => Response.json(catalog) });

    expect((await quoterFacts()).engines).toBe("live");
  });

  it("gives no fact when the quoter cannot be reached, and does not throw", async () => {
    stubQuoter({});

    expect(await quoterFacts()).toEqual({ engines: undefined, catalog: undefined });
  });

  it("gives the facts it has when one question fails", async () => {
    stubQuoter({ "/healthz": () => Response.json(health("fake")) });

    expect(await quoterFacts()).toEqual({ engines: "fake", catalog: undefined });
  });

  it("gives no fact from an answer that is not the quoter's (an error page)", async () => {
    stubQuoter({
      "/healthz": () => new Response("<html>bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } }),
      "/v1/catalog": () => new Response("nope", { status: 500 }),
    });

    expect(await quoterFacts()).toEqual({ engines: undefined, catalog: undefined });
  });
});
