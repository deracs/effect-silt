import { defineConfig } from "vitest/config"
import siltPlugin from "./src/vite-plugin.ts"

export default defineConfig({
  plugins: [siltPlugin()],
  test: { include: ["src/**/*.test.ts", "tests/**/*.test.ts"] },
})
