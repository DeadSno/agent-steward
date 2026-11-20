# QA-A2.6 — Исключение GUI/TUI из контура типизации (явная фиксация)

> Статус: **решение зафиксировано**. Эпик QA-A2 «Полная типизация плагина».
> Подзадача ROADMAP: QA-A2.6 — `src/gui.tsx`, `src/tui*.tsx` сейчас исключены из
> `tsconfig.json` и не попадают под `files: ["src/**/*.ts"]` ESLint. Здесь исключение
> **перестаёт быть молчаливым**: приведены причины и конкретный план подключения.

## 1. Что именно исключено и где

|Файл|Исключён из `tsc`|Исключён из ESLint|Потребитель|
|---|---|---|---|
|`src/gui.tsx`|`tsconfig.json` → `exclude`|glob `files: ["src/**/*.ts"]` не матчит `.tsx`|`npm run build:gui` → Vite → `gui-experimental.cjs`; экспорт `./gui-experimental`|
|`src/tui.tsx`|`tsconfig.json` → `exclude`|тот же glob|экспорт `./tui` → `./src/tui.tsx` (сырой исходник, грузится OpenCode TUI)|
|`src/tui-v1.tsx`|`tsconfig.json` → `exclude`|тот же glob|импортируется из `src/tui.tsx` (`tuiV1`)|

Две независимые причины исключения из ESLint:

1. **Расширение.** В `eslint.config.mjs` единственный блок с правилами имеет
   `files: ["src/**/*.ts"]`. glob `*.ts` **не** покрывает `*.tsx`, поэтому три файла
   не попадают в линтер даже при Dream of type-aware правил.
2. **Type-aware парсинг.** Блок задаёт `parserOptions: { project: "./tsconfig.json" }`.
   Правила из `recommendedTypeChecked` / `stylisticTypeChecked` требуют, чтобы файл
   входил в TypeScript-программу. Пока файлы в `exclude`, подключить их к этому же
   `project` нельзя — ESLint упадёт с «file not found in project».

## 2. Почему исключение технически обосновано (не «забыли»)

### 2.1. Разные JSX-диалекты в трёх файлах

- `src/tui.tsx` и `src/tui-v1.tsx` помечены по-file pragmа
  `/** @jsxImportSource @opentui/solid */` — это JSX-примитивы `<box>`, `<text>`
  терминального UI (`@opentui/solid`).
- `src/gui.tsx` использует **Solid DOM** JSX (`solid-js`, `createSignal`,
  `ErrorBoundary`, `@opencode/plugin/gui`) и компилируется `vite-plugin-solid`
  (см. `vite.config.ts` → `gui({ outFile: "./gui-experimental.cjs" })`).

В базовом `tsconfig.json` стоит **один** `"jsxImportSource": "@opentui/solid"`,
что корректно для TUI, но **некорректно для GUI**. Включение всех трёх файлов в
один tsc-проект с этим ключом дало бы неверную типизацию JSX в `gui.tsx`. Именно
поэтому `jsx`-настройки в базовом конфиге есть, но на исключённые файлы не действуют.

### 2.2. Отдельный Vite-бандл, а не tsc-эмит

- Базовый `tsc` (`npm run build`) пишет ES-модули + `.d.ts` в `./dist` с
  `rootDir: "./src"`, `outDir: "./dist"`, `declaration: true`.
- `npm run build:gui` запускает **Vite** (`vite.config.ts`), официальный `gui()`-плагин
  подключает `vite-plugin-solid` и собирает **один CommonJS-бандл** `gui-experimental.cjs`
  в корне проекта (не в `dist/`). Зависимости `solid-js`, `@opencode/plugin/gui`,
  `effect` объявлены внешними.
- При `"jsx": "preserve"` tsc оставил бы JSX в выходе — неисполняемый для webview
  код. Полноценная трансформация JSX — задача Vite/Babel, а не tsc. Поэтому GUI
  принципиально не является продуктом basic-компиляции.

### 2.3. Dual-entry в `package.json`

Экспорты плагина разделены на два контура:

- `"."` → `dist/index.js` и `"./rpc"` → `dist/rpc.js` — артефакты tsc (типизируются);
- `"./tui"` → `./src/tui.tsx` — **сырой исходник** отдаётся хосту OpenCode, который
  сам транспайлит JSX через `@opentui/solid`;
- `"./gui-experimental"` → `./gui-experimental.cjs` — готовый Vite-бандл.

Добавление `.tsx` в общий `include` при `declaration: true` изменило бы набор
эмиттируемых файлов в `dist/` (появились бы `dist/gui.js`, `dist/tui.js`, `.d.ts`),
что не соответствует фактической схеме экспортов и может сломать `test-package-exports`.
Исключение — защита стабильности dual-entry, а не упущение.

## 3. План подключения с JSX-парсером (без изменения поведения)

> Важно: этот документ **фиксирует решение**; сами `tsconfig.json`,
> `eslint.config.mjs` и код в рамках QA-A2.6 **не меняются**. Ниже — план для
> отдельной правки (после закрытия текущего baseline-гейта QA-A2.0).

### Шаг 1. Выделить JSX в отдельные tsconfig-проекты

Создать два конфига (или один с разными pragmas — см. ниже), не трогая базовый:

- `tsconfig.jsx.json` (GUI):
  - `extends: "./tsconfig.json"`;
  - `compilerOptions`: `noEmit: true`, `jsx: "preserve"`, `jsxImportSource: "solid-js"`;
  - `include: ["src/gui.tsx", "src/**/*.ts"]` (все зависимости GUI: `rpc.ts`,
    `history.ts`, `i18n.ts`), `exclude: []` — явно переопределить наследуемый exclude.
  - Причина `noEmit`: конфиг только для проверки типов, артефакты собирает Vite.
- `tsconfig.tui.json` (TUI):
  - `extends: "./tsconfig.json"`;
  - `compilerOptions`: `noEmit: true`, `jsx: "preserve"`,
    `jsxImportSource: "@opentui/solid"` (совпадает с pragmа в файлах);
  - `include: ["src/tui.tsx", "src/tui-v1.tsx", "src/shared/**/*.ts",
    "src/core/scheduler/**/*.ts"]`, `exclude: []`.

Альтернатива (меньше конфигов): оставить `jsx: "preserve"` и положиться на
по-file `/** @jsxImportSource ... */` прагмы; тогда в `gui.tsx` нужно добавить
`/** @jsxImportSource solid-js */`. Это единственная правка кода в плане —
она семантически нейтральна и выполняется отдельным коммитом.

### Шаг 2. Подключить `.tsx` к ESLint вторым блоком

В `eslint.config.mjs` добавить после основного блока (не меняя существующий):

```
{
  files: ["src/**/*.tsx"],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      project: ["./tsconfig.jsx.json", "./tsconfig.tui.json"],
      ecmaFeatures: { jsx: true },
    },
  },
  extends: [
    ...tseslint.configs.recommendedTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
  ],
  rules: { /* те же warn-правила, что и в основном блоке */ },
}
```

`@typescript-eslint/parser` распознаёт JSX автоматически по расширению `.tsx`;
`ecmaFeatures.jsx: true` и массив `project` гарантируют type-aware правила для
обоих JSX-диалектов. `files: ["src/**/*.ts"]` в первом блоке остаётся без изменений —
пересечения не будет.

### Шаг 3. Скрипты и CI

- Добавить в `package.json`:
  - `"lint:jsx": "eslint src/gui.tsx src/tui.tsx src/tui-v1.tsx"`
  - `"typecheck:jsx": "tsc -p tsconfig.jsx.json --noEmit && tsc -p tsconfig.tui.json --noEmit"`
- В CI добавить шаги `npm run lint:jsx` и `npm run typecheck:jsx` рядом с
  основными `npm run lint` / `npm run build`, **не снимая** baseline-гейт QA-A2.0,
  пока счётчик предупреждений по `.ts` не обнулится.
- Обновить счётчики/описания в `test-docs.mjs`, если мета-гейт отслеживает
  список npm-скриптов (проверить перед правкой; при необходимости — отдельная
  подзадача QA-A2.7).

### Шаг 4. Верификация после подключения

1. `npx tsc -p tsconfig.jsx.json --noEmit` — 0 ошибок.
2. `npx tsc -p tsconfig.tui.json --noEmit` — 0 ошибок.
3. `npx eslint src/gui.tsx src/tui.tsx src/tui-v1.tsx` — 0 ошибок; новые
   `no-explicit-any` / `no-unsafe-*` устраняются по правилам QA-A2 (без `--fix`).
4. `npm run build` и `npm run build:gui` — оба бандла собираются, `dist/` и
   `gui-experimental.cjs` не изменили состав.
5. `node test-package-exports.mjs`, `npm test` — Dual-entry и регрессии зелёные.
6. Smoke: открыть GUI-панель и TUI-панель в OpenCode, убедиться в рендере
   (Solid DOM и OpenTUI соответственно).

### Шаг 5. Закрытие подзадачи

После успешной верификации — перенести QA-A2.6 в `CHANGELOG.md`, отметить
подзадачу `[x]` в ROADMAP и удалить её оттуда по правилу канбана (п. 3 §4 ROADMAP).
Поведение плагина не меняется → запись носит характер «типизация/инфраструктура».

## 4. Итог решения

На текущем шаге (QA-A2.6) исключение GUI/TUI **зафиксировано документально**:
причины — разные JSX-диалекты, отдельный Vite-CommonJS-бандл и dual-entry со
сырым `.tsx`-экспортом. Контур типизации эпика QA-A2 остаётся ограниченным
`src/**/*.ts` базового tsc-проекта; подключение JSX-файлов вынесено в
конкретный план (шаги 1–5) и не выполняется в этой подзадаче.
