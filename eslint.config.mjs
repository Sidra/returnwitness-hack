import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Agent worktrees live under .claude/; they are separate branches, linted there.
    ".claude/**",
    // Alternate dist dirs (pre-push build, capture dev servers).
    ".next-*/**",
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-prepush/**",
    "docs/screens/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
