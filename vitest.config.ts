import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Ink's colors and styles, which tests read back, are off where chalk sees no terminal.
    env: { FORCE_COLOR: "3" },
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/testing/setup.ts"]
  }
});
