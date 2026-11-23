# T-4 — Prompt caching статических схем (Деталь 3.10)

Дата: 23.11.2026
Статус: выполнено (T-4.1, T-4.2)

## T-4.1 — что реально поддерживается

Источник: документация OpenCode (`https://opencode.ai/docs/models.md#prompt-caching`,
раздел `ai.request` в `packages/ai/README.md`), запрошенная через Context7.

- OpenCode сам расставляет cache-breakpoints на маршрутах, где это нужно:
  **последнее определение инструмента, системный промпт, последнее сообщение**.
- Политика кэша задаётся на стороне OpenCode: `cache: "none" | "auto" | { tools,
  system, messages, ttl }`; по умолчанию включено.
- TTL задаётся конфигурацией провайдера/модели: `settings.cache.ttl` (`5m`,
  `1h`, `24h`). Anthropic принимает `5m`/`1h`, OpenAI — `prompt_cache_retention`
  / `prompt_cache_options.ttl`; Gemini кэширует автоматически и TTL игнорирует.
- Для Claude за OpenAI-совместимым прокси (LiteLLM и др.) OpenCode не может
  определить формат сам — нужно `compatibility.cacheFormat: "anthropic"`
  (или `"alibaba"` для Alibaba Model Studio).
- Нормализованная статистика возвращается провайдером в
  `usage.cacheReadInputTokens` / `cacheWriteInputTokens`.

**Вывод:** плагину не следует вставлять `cache_control` в схемы инструментов —
это дублирует работу OpenCode и ухудшает совместимость. Вклад плагина в
экономию — стабильность схемы между запусками (T-1/T-2/T-3) и видимость
эффекта кэша в метриках.

## T-4.2 — что сделано в плагине

1. `src/core/opencode-usage.ts`: `OpenCodeUsage` дополнен полями
   `cacheReadTokens` и `cacheWriteTokens`. Парсер понимает обе формы данных:
   - родную `data.tokens.cache.read` / `data.tokens.cache.write`;
   - нормализованную `data.usage.cacheReadInputTokens` /
     `data.usage.cacheWriteInputTokens`.
   Отсутствующие или мусорные значения безопасно превращаются в 0; общий
   `tokens` по-прежнему включает cache-токены, если нет явного `total`.
2. `test-usage-from-log.mjs`: новая изолированная БД с двумя сообщениями в разных
   форматах; проверка агрегации read=650, write=150, tokens=1500.
3. `docs/COMPATIBILITY.md`: раздел «Prompt caching и статические схемы
   инструментов (T-4)» с правилами, примерами конфигурации и оговоркой про
   будущие MCP/dsh-адаптеры.
4. Адаптеры: V1 (`createV1Hooks`) и V2 используют общий `createToolSpecs()`;
   отдельные файлы MCP/dsh-адаптеров в репозитории пока отсутствуют, поэтому
   «включение кэширования» для них означает обязательное переиспользование
   статического реестра — это зафиксировано в документации и тестах
   (`test-v1-integration.mjs`, `test-dual-entry.mjs`).

## Проверка

- `npm run build` — exit 0.
- `node test-usage-from-log.mjs` — 27/27, exit 0.
- `node test-docs.mjs` — 139/139, exit 0.
- `node test-test-plan.mjs` — 19/19, exit 0.
- `node test-agent-tools.mjs` — 74/74, exit 0.

Строки T-4.1/T-4.2 и заголовок задачи удалены из `ROADMAP.md`; записи
добавлены в `CHANGELOG.md` под `[Unreleased]`.
