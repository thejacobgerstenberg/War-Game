/**
 * Playwright E2E configuration for the IMPERIUM lobby.
 *
 * Boots the real stack on dedicated ports (so it never collides with a dev
 * `npm run dev` on 8080/5173):
 *   - server:  http://localhost:4610  (readiness probe: GET /healthz)
 *   - client:  http://localhost:5610  (vite dev, --strictPort)
 *
 * CORS_ORIGIN must exactly match the vite origin, and VITE_SERVER_URL points
 * the browser's socket.io client at the test server.
 *
 * NOTE on browsers: this environment ships pre-installed browsers at
 * PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers (chromium-1194). @playwright/test
 * is pinned to 1.56.1 in the root package.json because that release expects
 * exactly chromium revision 1194 — do not bump it casually, and never run
 * `playwright install` here.
 */
import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(e2eDir, "..");

const SERVER_PORT = 4610;
const CLIENT_PORT = 5610;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const CLIENT_URL = `http://localhost:${CLIENT_PORT}`;

export default defineConfig({
  testDir: path.join(e2eDir, "tests"),
  outputDir: path.join(e2eDir, "test-results"),
  // All tests share one in-memory server; each test uses its own room, but
  // run serially in a single worker to keep logs/traces deterministic.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    baseURL: CLIENT_URL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // @imperium/shared must be compiled before the server (tsx) can import
      // its dist/ — chain the build into the server boot. The client entry
      // below does NOT need its own shared build: Playwright waits for BOTH
      // webServers before running tests, and vite resolves imports lazily,
      // so by the time a page loads, this chain has already built shared.
      command:
        "npm run build --workspace @imperium/shared && npm run dev --workspace @imperium/server",
      cwd: repoRoot,
      url: `${SERVER_URL}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PORT: String(SERVER_PORT),
        CORS_ORIGIN: CLIENT_URL,
      },
    },
    {
      command: `npm run dev --workspace @imperium/client -- --port ${CLIENT_PORT} --strictPort`,
      cwd: repoRoot,
      url: CLIENT_URL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_SERVER_URL: SERVER_URL,
      },
    },
  ],
});
