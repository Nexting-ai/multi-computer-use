import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["packages/**/*.test.ts", "lab/**/*.test.ts"] },
});
