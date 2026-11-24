# QA-A2.6 — Исключение GUI/TUI из контура типизации (явная фиксация)

Статус: **исключение зафиксировано явно** (вместо молчаливого). Ветка: `dev`.
Эпик: QA-A2 «Полная типизация плагина». Ссылка: `ROADMAP.md`, подзадача QA-A2.6
(в списке подзадач `ROADMAP.md` прямо перечислена QA-A2.7; QA-A2.6 фиксируется
настоящим документом как часть того же эпика).

Цель подзадачи — не «типизировать GUI/TUI прямо сейчас», а прервать статус
*silent-исключения*: записать, **почему** три `.tsx`-файла не попадают ни в `tsc`,
ни в ESLint, и дать воспроизводимый план их подключения с JSX-парсером. Настоящая
правка — **только документация**; `tsconfig.json`, `eslint.config.mjs` и код не
изменяются.

## 1. Фактическое состояние (что и где настроено)

### 1.1 `tsconfig.json`

- `include: ["src/**/*"]` — формально покрывает весь `src/`.
- `exclude: ["node_modules", "dist", "src/tui.tsx", "src/tui-v1.tsx", "src/gui.tsx"]`
  — три JSX-файла исключены **явно, но без объяснения причины** (это и есть
  «молчаливое исключение»).
- При этом компилятор *уже* настроен на JSX: `jsx: "preserve"`,
  `jsxImportSource: "@opentui/solid"`, `resolveJsonModule: true`,
  `declaration: true`, `module: "Node16"`, `outDir: "./dist"`.
  То есть конфиг выглядит «готовым к JSX», из-за чего исключение выглядит
  случайным — отсюда и возникла задача QA-A2.6.

### 1.2 `eslint.config.mjs`

- Глобальный `ignores`: `dist/`, `node_modules/`, `*.cjs`, `*.mjs`, `*.js`, `scripts/`.
- Рабочий блок: `files: ["src/**/*.ts"]` — glob матчит **только `.ts`**, но не
  `.tsx`. Следовательно `src/gui.tsx`, `src/tui.tsx`, `src/tui-v1.tsx` не
  попадают под линтер даже при том, что `parserOptions.project: "./tsconfig.json"`
  и подключены `recommendedTypeChecked` + `stylisticTypeChecked`.
- Второй блок `files: ["src/core/**/*.ts"]` c локальным правилом
  `no-any-in-catch` тоже `.tsx` не затрагивает.

Итог: файлы выпадают из обоих контуров **дважды** — через `exclude` в `tsconfig`
и через `files`-паттерн в ESLint.

### 1.3 Сборка и точки входа (dual-entry)

`package.json` задаёт четыре независимых пути сборки/загрузки:

| Экспорт | Цель | Инструмент |
| --- | --- | --- |
| `.` | `dist/index.js` (основной плагин) | `tsc` (`npm run build`) |
| `./rpc` | `dist/rpc.js` | `tsc` |
| `./tui` | `src/tui.tsx` (сырой TSX, грузится OpenCode TUI-рантаймом) | OpenCode TUI loader |
| `./gui-experimental` | `gui-experimental.cjs` (один CJS-бандл в корне) | Vite, `npm run build:gui` |

`vite.config.ts` подключает официальный `gui()` из `@opencode/plugin/gui/vite`,
который сам подключает `vite-plugin-solid`, компилирует Solid JSX и пишет
`gui-experimental.cjs`. GUI-бандл, таким образом, **собирается не `tsc`**, а
отдельным Vite-проходом с `prepublishOnly: npm run build && npm run build:gui`.

## 2. Почему исключение существует и чем опасно «просто убрать exclude»

1. **Два разных JSX-рантайма в одном проекте.**
   - `src/gui.tsx` импортирует `solid-js` и `@opencode/plugin/gui`, использует
     Solid JSX и JSON-импорты каталогов (`../locales/*.json`).
   - `src/tui.tsx` начинается с директивы `/** @jsxImportSource @opentui/solid */`
     и использует OpenTUI-примитивы `<box>`, `<text>`.
   - `src/tui-v1.tsx` — V1-ветка TUI, тоже с `/** @jsxImportSource @opentui/solid */`.
   Глобальный `jsxImportSource: "@opentui/solid"` в `tsconfig.json` корректен
   для TUI, но **не для GUI**. Один `tsconfig` не может одновременно и корректно
   типизировать оба рантайма без per-file `@jsxImportSource`-директив.

2. **`tsc` производит артефакты для Node16 ESM, а не для JSX-рантаймов.**
   При `jsx: "preserve"` компиляция `.tsx` оставит JSX в `.jsx`-файлах в `dist/` —
   такой файл не выполнится загрузчиком Node16 ESM. Плюс `declaration: true`
   сгенерирует `.d.ts` для GUI/TUI, которые в пакете не используются (GUI
   потребляется как готовый CJS-бандл, TUI — как исходный TSX). Прямое удаление
   из `exclude` меняет состав `dist/` и ломает `npm run build` / целостность
   `exports` (`test-package-exports.mjs`).

3. **Отдельный Vite-бандл.** GUI собирается в `gui-experimental.cjs` через
   `gui()`-плагин с внешними `solid-js`/`@opencode/plugin/gui`. Это отдельный
   контур: типы GUI проверять можно, но *эмит* `tsc` для GUI не нужен и вреден.

4. **Dual-entry / загрузка сырого TSX.** `./tui` указывает прямо на
   `src/tui.tsx`; OpenCode V2 подхватывает его как TUI-точку входа. Это
   «рантайм-исходник», а не вход для `tsc`. Попытка перевести его в `dist/`
   потребует менять `exports` и синхронизировать V1/V2-совместимость
   (`docs/COMPATIBILITY.md`, `test-docs.mjs`).

5. **Typed ESLint требует присутствия файла в TS-программе.** Даже если просто
   добавить `.tsx` в `files` ESLint, `recommendedTypeChecked` с
   `parserOptions.project: "./tsconfig.json"` упадёт с ошибкой вида
   *«file was not found by the project»*, пока файлы не включены в какую-либо
   TS-программу. Поэтому ESLint и tsc должны подключаться **в связке**.

Вывод: текущее исключение — **осознанная техническая необходимость**, которая
до сих пор была не задокументирована. Настоящий документ делает её явной.

## 3. Решение QA-A2.6

Исключение GUI/TUI из `tsc`-сборки и из ESLint объявляется **явным и
обоснованным** (п. 2). Эпик QA-A2 считается закрытым в части GUI/TUI не через
«включить любой ценой», а через фиксацию причины и конкретный план
подключения (п. 4), который выполняется отдельной правкой с полными тестами.

> Важно: «полностью типизированный плагин» в контексте QA-A2 означает полную
> типизацию **серверного контура** (`src/**/*.ts`, собираемого `tsc` и
> проверяемого ESLint). GUI/TUI — отдельные рантайм-контуры со своей сборкой;
> их подключение к проверке типов желательно, но не должно ломать dual-entry и
> V1/V2-совместимость.

## 4. План подключения GUI/TUI с JSX-парсером (отдельной правкой)

### Шаг 1 — выделить отдельную TS-программу для JSX (без эмита)

Создать `tsconfig.jsx.json`, расширяющий базовый:

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "declaration": false,
    "declarationMap": false,
    "jsx": "preserve",
    "jsxImportSource": "@opentui/solid"   // дефолт; GUI переопределит директивой
  },
  "include": ["src/gui.tsx", "src/tui.tsx", "src/tui-v1.tsx", "src/**/*.d.ts"],
  "exclude": []
}
```

- `noEmit: true` гарантирует: программа используется **только для проверки типов**,
  `dist/` не трогается, dual-entry и Vite-бандл не затрагиваются.
- Базовый `tsconfig.json` остаётся со своим `exclude` — именно он управляет
  *эмитом*; `tsconfig.jsx.json` — отдельный контур *проверки*.

### Шаг 2 — переключить JSX-рантайм на уровне файлов

- `src/tui.tsx` и `src/tui-v1.tsx` уже содержат
  `/** @jsxImportSource @opentui/solid */` — оставить как есть.
- `src/gui.tsx` — добавить `/** @jsxImportSource solid-js */` в первую строку,
  чтобы JSX-типы разрешались из Solid, а не из OpenTUI (директива файла имеет
  приоритет над `jsxImportSource` из `compilerOptions`).
- Альтернатива при желании избежать директив: `jsx: "react-jsx"` + два
  `tsconfig` (по одному на рантайм) — сложнее, рекомендуется вариант с pragma.

### Шаг 3 — подключить ESLint к JSX-программе

Добавить в `eslint.config.mjs` блок после базового:

```js
{
  files: ["src/**/*.tsx"],
  languageOptions: {
    parserOptions: { project: "./tsconfig.jsx.json" }
  }
}
```

- Отдельный `@typescript-eslint/parser` подключать не нужно: `typescript-eslint`
  уже парсит TSX его собственным парсером (espree с TSX не справился бы).
- Наследованные правила (`recommendedTypeChecked`, `stylisticTypeChecked`,
  `semi`, `quotes`, `indent`, `no-console`, `no-explicit-any: warn` и т.д.)
  применятся к `.tsx` автоматически. При желании — добавить точечные
  JSX-специфичные правила после стабилизации baseline.
- Убедиться, что `npm run lint` (`eslint src`) теперь действительно посещает
  `.tsx` (проверить `--debug`/списком файлов), иначе явно перечислить их в
  `files`.

### Шаг 4 — скрипты и CI

- Добавить в `package.json`:
  - `"typecheck:jsx": "tsc -p tsconfig.jsx.json"`;
  - `"lint:jsx": "eslint src --ext .ts,.tsx"` (или включить `.tsx` в общий
    `npm run lint`).
- Добавить оба вызова в CI-воркфлоу рядом с `npm run lint` / `npm run build`.
- Обновлять `test-docs.mjs`-связанные доки только при изменении счётчиков
  tools/RPC — в данном плане они не меняются.

### Шаг 5 — проверки после подключения (обязательно)

- `npm run build` — убедиться, что состав `dist/` и `npm pack --dry-run` не
  изменились; `node test-package-exports.mjs` — целостность `exports`.
- `npm run lint` и `npm run typecheck:jsx` — 0 ошибок; новые `any` в `.tsx`
  разбираются по правилам QA-A2 (сужать через type guard / `z.infer`).
- GUI/RPC-контур (по правилам AGENTS.md): `npm run test:dlq-gui`,
  `npm run test:pause-gui`, `npm run test:gui-bundle` + smoke в Playwright.
- V1/V2-совместимость и мета-гейт: `node test-docs.mjs`, `node test-workflows.mjs`.
- `npm run test:i18n` — `gui.tsx` инлайн-регистрирует `ru/en/zh`-каталоги;
  типизация JSON-импортов не должна сломать паритет ключей.

### Риски и оговорки

- Добавление `.tsx` в линтер может вскрыть значительный легаси-долг в GUI/TUI;
  чтобы не ронять CI, новые предупреждения временно держать в baseline
  (по образцу QA-A2.0), затем «вылизывать» по QA-A2.1–A2.5.
- GUI-бандл (`gui-experimental.cjs`) и `dist/` — артефакты сборки, **не редактировать
  вручную** (правило AGENTS.md).
- Любая правка `exports`/сборки GUI требует синхронизации `docs/COMPATIBILITY.md`
  и повторного `node test-docs.mjs`.

## 5. Критерии приёмки QA-A2.6

- [x] Прочитаны `ROADMAP.md` (эпик QA-A2), `tsconfig.json`, `eslint.config.mjs`.
- [x] Создан `docs/QA-A2-GUI-TUI.md` с объяснением причин исключения
      (JSX-парсер/рантайм, отдельный Vite-бандл, dual-entry) и планом подключения.
- [x] `tsconfig.json`, `eslint.config.mjs` и код не изменены.
- [x] Коммит/push не выполнялись; суб-агенты не спавнились.
