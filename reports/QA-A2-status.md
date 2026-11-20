# QA-A2 status

- Дата: 2026-11-20
- Ветка: dev
- Baseline: 543 warning / 0 error (новых предупреждений нет)

| Подзадача | Статус | Ожидаемый файл |
| --- | --- | --- |
| QA-A2.2 | ordered | `src/server.ts` |
| QA-A2.3 | ordered | `src/notifications.ts` |
| QA-A2.4 | ordered | `src/db/migrate.ts` |
| QA-A2.5 | ordered | `src/task-transfer.ts`, `src/workspaces.ts` и остальные файлы с 1–2 `any` |
| QA-A2.6 | ordered | `src/gui.tsx`, `src/tui*.tsx` |
| QA-A2.7 | ordered | весь проект (`npm run lint`, `npm run build`, `npm test`), снятие baseline-гейта |
