import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "jsdom", include: ["src/board/__tests__/**/*.test.ts"] },
});
