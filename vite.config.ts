import fs from "node:fs"
import path from "node:path"
import { defineConfig, type Plugin } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// QA-D316-23: `gui({ outFile: "./gui-experimental.cjs" })` заставляет плагин
// выставить `build.outDir = "."` (корень проекта), из-за чего Vite предупреждает
// о возможной перезаписи исходников. Собираем в отдельный каталог внутри
// уже игнорируемого git `node_modules/.cache/vite`, затем копируем готовый
// бандл на место — в корень, где его ждёт OpenCode и тесты.
const OUT_DIR = "node_modules/.cache/vite/gui-out"

function bundleName(debug: boolean): string {
  // D16 (IM-15): debug-сборка пишет отдельный бандл и source map,
  // не перезаписывая релизный gui-experimental.cjs.
  return debug ? "gui-experimental.debug.cjs" : "gui-experimental.cjs"
}

function copyGuiBundle(debug: boolean): Plugin {
  const fileName = bundleName(debug)
  let root = process.cwd()
  return {
    name: "copy-gui-bundle",
    configResolved(config) {
      root = config.root
    },
    closeBundle() {
      const from = path.join(root, OUT_DIR, fileName)
      const to = path.join(root, fileName)
      fs.copyFileSync(from, to)
      // В debug-режиме Vite кладёт .map рядом с бандлом в outDir — переносим
      // его вместе с бандлом, чтобы sourceMappingURL в корне остался рабочим.
      if (debug) {
        const mapFrom = `${from}.map`
        if (fs.existsSync(mapFrom)) fs.copyFileSync(mapFrom, `${to}.map`)
      }
    },
  }
}

export default defineConfig(({ mode }) => {
  const debug = mode === "debug" || process.env.AGENT_STEWARD_DEBUG === "1"
  return {
    cacheDir: "node_modules/.cache/vite",
    plugins: [gui({ outFile: `${OUT_DIR}/${bundleName(debug)}` }), copyGuiBundle(debug)],
    build: {
      // Отдельный outDir (не root и не родитель root) убирает warning Vite.
      outDir: OUT_DIR,
      emptyOutDir: false,
      ...(debug ? { sourcemap: true } : {}),
    },
  }
})
