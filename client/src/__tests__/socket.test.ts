import { describe, expect, it } from "vitest";
import { resolveServerUrl } from "../socket";

describe("resolveServerUrl", () => {
  it("uses VITE_SERVER_URL verbatim when set", () => {
    expect(
      resolveServerUrl({ VITE_SERVER_URL: "https://game.example.com", DEV: false }),
    ).toBe("https://game.example.com");
    expect(
      resolveServerUrl({ VITE_SERVER_URL: "http://10.0.0.5:8080", DEV: true }),
    ).toBe("http://10.0.0.5:8080");
  });

  it("falls back to localhost:8080 in dev when unset", () => {
    expect(resolveServerUrl({ DEV: true })).toBe("http://localhost:8080");
    expect(resolveServerUrl({ VITE_SERVER_URL: "", DEV: true })).toBe(
      "http://localhost:8080",
    );
  });

  it("falls back to same-origin (undefined) in production when unset", () => {
    expect(resolveServerUrl({ DEV: false })).toBeUndefined();
    expect(resolveServerUrl({})).toBeUndefined();
    expect(resolveServerUrl({ VITE_SERVER_URL: "", DEV: false })).toBeUndefined();
  });
});
