import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSession } from "@/lib/session";
import { fakeCookieStore } from "@/test/cookies";
import { catalog } from "@/test/fixtures";

import { GET } from "./route";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

function stubQuoter(answer: (request: Request) => Promise<Response>) {
  const quoter = vi.fn(answer);
  vi.stubGlobal("fetch", quoter);
  return quoter;
}

describe("GET /api/catalog", () => {
  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "a-test-secret-that-is-long-enough-to-seal");
    vi.stubEnv("QUOTER_URL", "http://quoter.test");
    fakeCookieStore();
    await createSession("marty");
  });

  it("passes the quoter's catalog through", async () => {
    const quoter = stubQuoter(async () => Response.json(catalog));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(catalog);
    expect(quoter.mock.calls[0][0].url).toBe("http://quoter.test/v1/catalog");
  });

  it("takes no say of the browser in where it goes", async () => {
    const quoter = stubQuoter(async () => Response.json(catalog));

    await (GET as (request: Request) => Promise<Response>)(new Request("http://web.test/api/catalog?quoter=http://evil.test"));

    expect(quoter.mock.calls[0][0].url).toBe("http://quoter.test/v1/catalog");
  });

  it("needs no session: the rules are the same for everyone", async () => {
    fakeCookieStore();
    stubQuoter(async () => Response.json(catalog));

    const response = await GET();

    expect(response.status).toBe(200);
  });

  it("answers quoter_unavailable when the quoter cannot be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubQuoter(async () => {
      throw new TypeError("fetch failed");
    });

    const response = await GET();

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "quoter_unavailable" });
  });
});
