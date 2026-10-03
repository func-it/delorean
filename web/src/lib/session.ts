import "server-only";

import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Sessions identify, they do not authenticate: a visitor picks a username,
 * with no password, so that the quoter traces can group requests by user and
 * by session. Nothing here proves who the visitor is.
 *
 * The session lives in a stateless cookie, sealed with iron-session
 * (AES-256-CBC encryption + HMAC-SHA-256 integrity). iron-session over jose:
 * it is built for exactly this (seal, cookie options, expiry in one call), takes
 * `await cookies()` as is, and supports secret rotation; with jose we would
 * write and maintain that glue ourselves.
 */
export interface Session {
  username: string;
  /** Random UUID, sent as `X-Session-Id` to group one visit's traces. */
  sessionId: string;
  /** ISO 8601. */
  createdAt: string;
}

/** Same rule as the contract's `X-User-Id` header. */
const USERNAME = /^[A-Za-z0-9._@-]{1,64}$/;

export function isValidUsername(value: string): boolean {
  return USERNAME.test(value);
}

const COOKIE_NAME = "delorean_session";
const TTL_SECONDS = 7 * 24 * 60 * 60;
const MIN_SECRET_LENGTH = 32;
const DEV_SECRET = "delorean-development-secret-do-not-use-in-production";

let warnedAboutDevSecret = false;

/** Read at request time, not at import, so that `next build` needs no secret. */
function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret) {
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters long.`);
    }
    return secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is required in production.");
  }
  if (!warnedAboutDevSecret) {
    console.warn("SESSION_SECRET is not set: using the development secret. Never do this in production.");
    warnedAboutDevSecret = true;
  }
  return DEV_SECRET;
}

/**
 * Secure in production, unless SESSION_COOKIE_SECURE=false says the app is
 * served over plain HTTP (docker compose on localhost). Some browsers drop a
 * Secure cookie that comes over HTTP, even from localhost; Next still renders
 * the page after the login with the cookie it has just set, so the visitor
 * would look signed in while every /api call answered 401.
 */
function secureCookie(): boolean {
  switch (process.env.SESSION_COOKIE_SECURE) {
    case "true":
      return true;
    case "false":
      return false;
  }
  return process.env.NODE_ENV === "production";
}

function sessionOptions(): SessionOptions {
  return {
    cookieName: COOKIE_NAME,
    password: sessionSecret(),
    ttl: TTL_SECONDS,
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookie(),
      path: "/",
    },
  };
}

async function ironSession() {
  return getIronSession<Session>(await cookies(), sessionOptions());
}

/** The current session, or null when the cookie is missing, expired or tampered with. */
export async function getSession(): Promise<Session | null> {
  const { username, sessionId, createdAt } = await ironSession();
  if (!username || !sessionId || !createdAt || !isValidUsername(username)) return null;
  return { username, sessionId, createdAt };
}

/** For pages: the current session, or a redirect to the login page. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/** Starts a new session. Server Functions and Route Handlers only (it sets a cookie). */
export async function createSession(username: string): Promise<Session> {
  if (!isValidUsername(username)) throw new Error("Invalid username.");
  const session = await ironSession();
  session.username = username;
  session.sessionId = crypto.randomUUID();
  session.createdAt = new Date().toISOString();
  await session.save();
  return { username: session.username, sessionId: session.sessionId, createdAt: session.createdAt };
}

export async function destroySession(): Promise<void> {
  (await ironSession()).destroy();
}
