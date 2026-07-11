import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
    environmentMatchGlobs: [["src/board/__tests__/**", "jsdom"]],
  },
});
