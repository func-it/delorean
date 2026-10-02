import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeCookieStore } from "@/test/cookies";

import { createSession, destroySession, getSession, isValidUsername, requireSession } from "./session";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

const SECRET = "a-test-secret-that-is-long-enough-to-seal";

describe("isValidUsername", () => {
  it.each(["marty", "doc.brown@hill-valley_85", "x".repeat(64)])("accepts %s", (name) => {
    expect(isValidUsername(name)).toBe(true);
  });

  it.each(["", "x".repeat(65), "marty mcfly", "émile", "doc/brown", "biff\n"])("rejects %j", (name) => {
    expect(isValidUsername(name)).toBe(false);
  });
});

describe("session cookie", () => {
  let store: ReturnType<typeof fakeCookieStore>;

  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    store = fakeCookieStore();
  });

  it("round-trips a new session through a sealed cookie", async () => {
    const created = await createSession("marty");

    expect(created.username).toBe("marty");
    expect(created.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(created.createdAt)).not.toBeNaN();
    expect(await getSession()).toEqual(created);

    const [value] = store.values.values();
    expect(value).not.toContain("marty");
  });

  it("sets an httpOnly, SameSite=Lax cookie, Secure in production only", async () => {
    await createSession("marty");
    expect(store.options.get("delorean_session")).toMatchObject({ httpOnly: true, sameSite: "lax", secure: false });

    vi.stubEnv("NODE_ENV", "production");
    await createSession("marty");
    expect(store.options.get("delorean_session")).toMatchObject({ secure: true });
  });

  it("drops Secure when SESSION_COOKIE_SECURE=false, for plain HTTP", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_COOKIE_SECURE", "false");
    await createSession("marty");
    expect(store.options.get("delorean_session")).toMatchObject({ secure: false });

    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_COOKIE_SECURE", "true");
    await createSession("marty");
    expect(store.options.get("delorean_session")).toMatchObject({ secure: true });
  });

  it("gives a new session id to every login", async () => {
    const first = await createSession("marty");
    const second = await createSession("marty");
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("has no session without a cookie", async () => {
    expect(await getSession()).toBeNull();
  });

  it("ignores a tampered cookie", async () => {
    await createSession("marty");
    const [[name, value]] = store.values;
    store.values.set(name, value.slice(0, -8) + "AAAAAAAA");
    expect(await getSession()).toBeNull();
  });

  it("ignores a cookie sealed with another secret", async () => {
    await createSession("marty");
    vi.stubEnv("SESSION_SECRET", "another-secret-just-as-long-as-the-first");
    expect(await getSession()).toBeNull();
  });

  it("ends the session on destroy", async () => {
    await createSession("marty");
    await destroySession();
    expect(await getSession()).toBeNull();
  });

  it("refuses an invalid username", async () => {
    await expect(createSession("marty mcfly")).rejects.toThrow("Invalid username");
  });

  it("redirects to the login page when a page requires a session", async () => {
    await expect(requireSession()).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/login");
  });
});

describe("SESSION_SECRET", () => {
  beforeEach(() => {
    fakeCookieStore();
  });

  it("is required in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    await expect(getSession()).rejects.toThrow("SESSION_SECRET is required in production");
  });

  it("must be at least 32 characters long", async () => {
    vi.stubEnv("SESSION_SECRET", "too-short");
    await expect(getSession()).rejects.toThrow("at least 32 characters");
  });

  it("falls back to a development secret, with a warning, outside production", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await createSession("marty");

    expect(await getSession()).toMatchObject({ username: "marty" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("SESSION_SECRET is not set"));
  });
});
