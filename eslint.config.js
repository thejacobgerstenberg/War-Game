// @ts-check
/**
 * ESLint 9 flat config for the IMPERIUM monorepo.
 *
 * Deliberately minimal: eslint + typescript-eslint *recommended* rule sets
 * only (correctness, no style bikeshedding), scoped to the three workspaces'
 * source trees. Run from the repo root with `npm run lint`.
 */
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  {
    files: [
      "shared/src/**/*.ts",
      "server/src/**/*.ts",
      "client/src/**/*.{ts,tsx}",
    ],
    extends: [eslint.configs.recommended, tseslint.configs.recommended],
  },
);
