import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// D16 (IM-15): debug-сборка пишет отдельный бандл и source map,
// не перезаписывая релизный gui-experimental.cjs.
export default defineConfig(({ mode }) => {
  const debug = mode === "debug" || process.env.AGENT_STEWARD_DEBUG === "1"
  return {
    cacheDir: "node_modules/.cache/vite",
    plugins: [gui({ outFile: debug ? "./gui-experimental.debug.cjs" : "./gui-experimental.cjs" })],
    build: debug ? { sourcemap: true } : {},
  }
})
