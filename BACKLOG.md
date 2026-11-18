# BACKLOG — удалён (переход на канбан)

**Дата:** 18.11.2026.
**Причина:** схема работы изменена на канбан — спринты и привязка задач к версиям убраны.

Все актуальные задачи теперь живут в [ROADMAP.md](./ROADMAP.md) как канбан-пул (статусы ⬜ / 🔄 / ✅, приоритеты P0–P3).
Выпущенные изменения перенесены в [CHANGELOG.md](./CHANGELOG.md).

Порядок работы:
1. Берём одну задачу из ROADMAP.md (начиная с P0/P1, затем P2, P3).
2. Выполняем код + документацию + тест.
3. Пишем отчёт, ставим статус ✅, переходим к следующей.
4. Нет спринтов, нет привязки к версиям — версия определяется фактом релиза по semver.

<dcp-system-reminder>
Next: fix documentation inconsistencies (ROADMAP.md version, SECURITY.md supported versions, TEST-PLAN.md version/date, ROADMAP-STRATEGY.md "durable DAG" claim).
</dcp-system-reminder>