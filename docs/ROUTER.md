# Capability Router (`agent-steward/router`, Деталь 3.19 / S-2)

Публичный сабпат с маршрутизацией шагов и flywheel-обучением. Само решение
**не вызывает модель и не открывает БД**: это чистые функции над accumulated
gate-исходами, поэтому cost роутинга равен 0 токенов.

```js
import { createCapabilityRouter } from "agent-steward/router";

const router = createCapabilityRouter();
router.route("run_tests"); // { target: "local", reason: "static-rule", transport: "direct", ... }
router.learn({ taskType: "audit", passed: true, attempts: 1 });
router.route("audit");     // explore → local после 3 успешных first-pass исходов
const snapshot = router.snapshot();
const restored = createCapabilityRouter({}, snapshot); // обучение продолжается
```

## Слои

| Слой | Что делает | Где |
| --- | --- | --- |
| 1. Статические правила | Known task type → транспорт + исполнитель, без данных и без модели | [`src/core/router/rules.ts`](src/core/router/rules.ts) |
| 2. Обучение | `first_pass_rate`, затухающий success rate, пороги local/cloud/review | [`src/core/router/capability-math.ts`](src/core/router/capability-math.ts) |
| 3. Модель | Разбивает миссию на шаги с типами; маршрут уже выбран слоями 1/2 | `src/core/router/planner.ts` |

Статические правила выигрывают по умолчанию (`reason: "static-rule"`,
`source: "static"`, поле `transport`). Чтобы обученная метрика могла их
перекрыть, конструктору передаётся `{ learnedOverridesStatic: true }` — тогда
после `minRuns` исходов решение приходит из слоя 2 (`source: "learned"`).

## Метрики и пороги

- `successRate = runsPassed / runsTotal` — кумулятивный успех.
- `firstPassRate = firstPassCount / runsTotal` — доля успехов с первой попытки.
  По умолчанию `firstPass = passed && (attempts === undefined || attempts === 1)`;
  явный `firstPass: true` разрешён только для `passed: true`.
- `decayedSuccessRate` — экспоненциально взвешенный success rate последних
  `RECENT_RUNS_LIMIT = 10` исходов, `half-life = SUCCESS_HALF_LIFE_RUNS = 8`.
- `effectiveSuccessRate = 0.7 × decayedSuccessRate + 0.3 × firstPassRate`
  (`DECAY_WEIGHT` / `FIRST_PASS_WEIGHT`) — именно он сравнивается с порогами.

| Порог | Значение по умолчанию | Смысл |
| --- | --- | --- |
| `LOCAL_SUCCESS_THRESHOLD` | 0.85 | выше — надёжно, `local` |
| `CLOUD_FAILURE_THRESHOLD` | 0.30 | ниже — безнадёжно, `cloud` |
| `MIN_RUNS_FOR_DECISION` | 3 | меньше исходов — `explore` |
| между порогами | — | нестабильно, `review` |

Все константы и формулы экспортируются; SQLite-карта
[`src/db/capability-repo.ts`](src/db/capability-repo.ts) использует **те же**
функции из `capability-math`, поэтому офлайн-роутер и durable-карта не
расходятся. Разница лишь в хранении: сабпат держит состояние в памяти и
передаёт его снимком, карта пишет в таблицу `capability_map`.

## API

- `createCapabilityRouter(options?, initial?)` — создать роутер; `initial` — снимок.
- `route(taskType)` — решение без мутации состояния.
- `learn(outcome)` — записать исход гейта (`passed`, `attempts?`, `firstPass?`) и
  вернуть свежее решение. Предыдущая запись не мутируется.
- `get(taskType)` — копия накопленной записи или `null`.
- `snapshot()` / `restore(snapshot)` — детерминированный снимок (ключи
  отсортированы) с проверкой версии и порогов.
- `reset()` — очистить обученную статистику.

Снимок имеет `version: 1` (`CAPABILITY_ROUTER_SNAPSHOT_VERSION`); чужая версия
или несовпадение порогов отклоняется явной ошибкой.

## Проверка

```bash
npm run build
npm run test:router          # формулы, flywheel, снимки, статические правила
npm run test:capability-map  # регрессия SQLite-карты после выноса формул
npm run test:docs
```

Контракт сабпата проверяет `test-router.mjs`: в том числе отсутствие
`@opencode-*` и `src/db` в графе импортов, паритет формул с `capability-repo`
и приоритет статического правила.
