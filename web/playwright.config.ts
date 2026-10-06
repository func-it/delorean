import { defineConfig, devices } from "@playwright/test";

/**
 * The web app end to end, in a real browser, against a running stack: the
 * page, the BFF, the session cookie and the quoter on its fake engines
 * (scripts/web-e2e.sh starts one apart from any other). BASE_URL says where.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: 0,
  workers: 4,
  reporter: "list",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:24790",
    locale: "fr-FR",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
