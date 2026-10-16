import { defineConfig } from "vitest/config"

// Headless-browser checks: a built package, its preview server and Chromium through Playwright
export default defineConfig({
  test: { include: ["test/smoke/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 180_000, fileParallelism: false },
})
