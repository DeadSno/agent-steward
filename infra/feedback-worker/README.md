# Feedback receiver (Деталь 3.8, F-2)

Write-only приёмник баг-репортов: `POST /report` → GitHub Issue в
`DeadSno/agent-steward`. Никаких данных от воркера обратно в плагин, кроме
`issueUrl` — канал односторонний.

## Контракт

Плагин отправляет JSON:

```json
{
  "schemaVersion": 1,
  "reportId": "uuid",
  "createdAt": "2026-11-20T10:00:00.000Z",
  "pluginVersion": "0.0.5",
  "os": { "platform": "win32", "release": "10.0", "arch": "x64" },
  "node": "v22.0.0",
  "locale": "ru",
  "profile": "default",
  "taskName": "example",
  "description": "что сломалось",
  "contactEmail": "user@example.com",
  "redactedLogs": "…",
  "metrics": { "total": 10, "success": 8, "error": 2 },
  "website": ""
}
```

Ответы: `200 { "ok": true, "issueUrl": "https://github.com/…/issues/N" }`,
`400` при неверной схеме, `413` при слишком большом теле, `429` при
превышении лимита, `502` если GitHub недоступен/отверг запрос, `500` если
не задан `GITHUB_TOKEN`. Логи воркера не содержат PII — только `reportId`,
статус и код причины.

## Развёртывание (F-2.5)

1. Создайте fine-grained PAT с единственным правом **Issues: write** на
   `DeadSno/agent-steward` (Repository permissions → Issues → Read and write;
   остальное — None). Срок — минимально возможный.
2. Установите секрет **в два шага** (встречающаяся ошибка — вставить сам PAT
   в ответ на вопрос «Enter the name of your secret variable», тогда секрет
   сохраняется под именем токена, а воркер отвечает `500 receiver is not
   configured`):

   ```powershell
   npx wrangler secret put GITHUB_TOKEN
   # Enter the name of your secret variable: GITHUB_TOKEN
   # Enter a secret value: <вставьте PAT сюда>
   npx wrangler secret list   # в списке должно быть имя GITHUB_TOKEN
   ```

3. KV-привязки по умолчанию отключены: воркер использует in-memory хранилища
   для дедупа по `reportId` и rate-limit по IP (сбрасываются при рестарте
   изолята). Для персистентности создайте пространства и раскомментируйте
   блоки `[[kv_namespaces]]` в `wrangler.toml`, подставив выданные ID:

   ```powershell
   npx wrangler kv namespace create FEEDBACK_DEDUP
   npx wrangler kv namespace create FEEDBACK_RATELIMIT
   ```
4. Деплой: `npx wrangler deploy`. Скопируйте публичный URL.
5. В плагине: **Settings → Обратная связь с автором** → включить, вставить
   URL вида `https://agent-steward-feedback.<account>.workers.dev/report`.

Проверка перед включением:

```bash
curl -X POST "$URL" -H 'content-type: application/json' \
  -d '{"schemaVersion":1,"reportId":"probe-0001","createdAt":"2026-01-01T00:00:00Z","pluginVersion":"probe","os":{"platform":"test"},"node":"v22","description":"probe"}'
```

> На Windows с устаревшим Schannel `curl`/Node по умолчанию выбирают TLS 1.2 и
> получают от `*.workers.dev` `SSL alert 40`. В таком случае форсируйте TLS 1.3:
> `curl --tlsv1.3 …` либо в Node `https.request(..., { minVersion: 'TLSv1.3' })`.
> Это ограничение локального клиента, не воркера.

Живая проверка 20.11.2026: `POST /report` → `200` и
`https://github.com/DeadSno/agent-steward/issues/6`
(метки `user-report`, `needs-triage`).

## Приватность

- по умолчанию логи **не** прикладываются (`includeLogs: false`);
- клиент вырезает токены (`sk-`, `ghp_`, `xox*`, bot tokens), значения из
  `manage_secrets`, домашний путь → `~` и email → `[EMAIL]`;
- `contactEmail` отправляется только если пользователь указал его явно;
- `website` — honeypot против ботов: заполненное поле даёт молчаливый `200`
  без создания issue;

## Тесты

```bash
node --test test-feedback-worker.mjs
```
