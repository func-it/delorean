import { cookies } from "next/headers";
import { vi } from "vitest";

interface CookieOptions {
  maxAge?: number;
  httpOnly?: boolean;
  sameSite?: string;
  secure?: boolean;
}

/**
 * An in-memory stand-in for `await cookies()`. The test file must mock the
 * module first: `vi.mock("next/headers", () => ({ cookies: vi.fn() }))`.
 */
export function fakeCookieStore() {
  const values = new Map<string, string>();
  const options = new Map<string, CookieOptions>();
  const store = {
    values,
    options,
    get: (name: string) => (values.has(name) ? { name, value: values.get(name)! } : undefined),
    getAll: () => [...values].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, cookie: CookieOptions = {}) => {
      options.set(name, cookie);
      if (cookie.maxAge === 0) values.delete(name);
      else values.set(name, value);
    },
  };
  vi.mocked(cookies).mockResolvedValue(store as unknown as Awaited<ReturnType<typeof cookies>>);
  return store;
}
