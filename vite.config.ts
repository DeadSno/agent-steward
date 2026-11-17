import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// Официальный gui()-плагин сам:
// - подключает vite-plugin-solid и компилирует Solid JSX;
// - пишет один CommonJS-бандл gui-experimental.cjs в корень проекта
//   (outFile "./gui-experimental.cjs" разрешается от корня, не от dist/);
// - держит предоставляемые приложением модули (solid-js, @opencode/plugin/gui, effect) внешними.
export default defineConfig({
  plugins: [gui({ outFile: "./gui-experimental.cjs" })],
})
