import { NextRequest } from "next/server";
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
    vi.stubEnv("QUOTERS", '{"go":"http://go.test","python":"http://python.test"}');
    fakeCookieStore();
    await createSession("marty");
  });

  it("passes the default quoter's catalog through", async () => {
    const quoter = stubQuoter(async () => Response.json(catalog));

    const response = await GET(new NextRequest("http://web.test/api/catalog"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(catalog);
    expect(quoter.mock.calls[0][0].url).toBe("http://go.test/v1/catalog");
  });

  it("reads the catalog of the quoter picked by name", async () => {
    const quoter = stubQuoter(async () => Response.json(catalog));

    await GET(new NextRequest("http://web.test/api/catalog?quoter=python"));

    expect(quoter.mock.calls[0][0].url).toBe("http://python.test/v1/catalog");
  });

  it("refuses a quoter outside the allowlist", async () => {
    const quoter = stubQuoter(async () => Response.json(catalog));

    const response = await GET(new NextRequest("http://web.test/api/catalog?quoter=http://evil.test"));

    expect(response.status).toBe(400);
    expect(quoter).not.toHaveBeenCalled();
  });

  it("needs no session: the rules are the same for everyone", async () => {
    fakeCookieStore();
    stubQuoter(async () => Response.json(catalog));

    const response = await GET(new NextRequest("http://web.test/api/catalog"));

    expect(response.status).toBe(200);
  });

  it("answers quoter_unavailable when the quoter cannot be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubQuoter(async () => {
      throw new TypeError("fetch failed");
    });

    const response = await GET(new NextRequest("http://web.test/api/catalog"));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "quoter_unavailable" });
  });
});
