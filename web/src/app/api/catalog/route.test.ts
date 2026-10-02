import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSession } from "@/lib/session";
import { fakeCookieStore } from "@/test/cookies";
import { catalog } from "@/test/fixtures";

import { GET } from "./route";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

function stubBackend(answer: (request: Request) => Promise<Response>) {
  const backend = vi.fn(answer);
  vi.stubGlobal("fetch", backend);
  return backend;
}

describe("GET /api/catalog", () => {
  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "a-test-secret-that-is-long-enough-to-seal");
    vi.stubEnv("BACKENDS", '{"go":"http://go.test","python":"http://python.test"}');
    fakeCookieStore();
    await createSession("marty");
  });

  it("passes the default backend's catalog through", async () => {
    const backend = stubBackend(async () => Response.json(catalog));

    const response = await GET(new NextRequest("http://web.test/api/catalog"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(catalog);
    expect(backend.mock.calls[0][0].url).toBe("http://go.test/v1/catalog");
  });

  it("reads the catalog of the backend picked by name", async () => {
    const backend = stubBackend(async () => Response.json(catalog));

    await GET(new NextRequest("http://web.test/api/catalog?backend=python"));

    expect(backend.mock.calls[0][0].url).toBe("http://python.test/v1/catalog");
  });

  it("refuses a backend outside the allowlist", async () => {
    const backend = stubBackend(async () => Response.json(catalog));

    const response = await GET(new NextRequest("http://web.test/api/catalog?backend=http://evil.test"));

    expect(response.status).toBe(400);
    expect(backend).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    fakeCookieStore();
    const backend = stubBackend(async () => Response.json(catalog));

    const response = await GET(new NextRequest("http://web.test/api/catalog"));

    expect(response.status).toBe(401);
    expect(backend).not.toHaveBeenCalled();
  });

  it("answers backend_unavailable when the backend cannot be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubBackend(async () => {
      throw new TypeError("fetch failed");
    });

    const response = await GET(new NextRequest("http://web.test/api/catalog"));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "backend_unavailable" });
  });
});
