/**
 * Схема БД планировщика (Спринт 12 + workspaces из Спринта 13).
 *
 * Все таблицы создаются идемпотентно (IF NOT EXISTS), поэтому schema.ts можно
 * безопасно выполнять при каждом открытии соединения — это же служит
 * механизмом «мини-миграций» при обновлении плагина.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  name TEXT PRIMARY KEY,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  matrix_parent_id TEXT,
  is_matrix_parent INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  error TEXT,
  tokens INTEGER,
  cost_usd REAL,
  model TEXT,
  pre_flight_status TEXT,
  post_flight_status TEXT,
  next_task TEXT,
  workspace_id TEXT,
  allowed_tools TEXT,
  denied_tools TEXT
);

CREATE INDEX IF NOT EXISTS idx_history_task ON history(task_name, started_at DESC);

CREATE TABLE IF NOT EXISTS metrics (
  task_name TEXT PRIMARY KEY,
  total INTEGER DEFAULT 0,
  success INTEGER DEFAULT 0,
  error INTEGER DEFAULT 0,
  partial INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  total_cost REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  git_remote TEXT,
  color TEXT,
  env_json TEXT,
  env_file TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target TEXT,
  actor TEXT NOT NULL,
  source TEXT,
  details_json TEXT,
  remote TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, ts DESC);

-- Спринт 27: последний обработанный коммит для git-триггеров.
CREATE TABLE IF NOT EXISTS git_state (
  task_name TEXT PRIMARY KEY,
  commit_sha TEXT NOT NULL,
  branch TEXT,
  updated_at TEXT NOT NULL
);

-- Спринт 31.2: дедуп уведомлений (отслеживание повторов между процессами).
CREATE TABLE IF NOT EXISTS notification_dedup (
  key TEXT PRIMARY KEY,
  task_name TEXT NOT NULL,
  status TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  window_minutes INTEGER NOT NULL DEFAULT 60
);

CREATE INDEX IF NOT EXISTS idx_notification_dedup_key ON notification_dedup(key);
CREATE INDEX IF NOT EXISTS idx_notification_dedup_last_at ON notification_dedup(last_at);

-- Векторы сообщений для семантического дедупа (Спринт 31.1).
-- Хранятся нормализованные эмбеддинги (JSON-массив чисел) и текст сообщения.
-- Сравнение по косинусу брутфорсом по всем векторам в окне.
CREATE TABLE IF NOT EXISTS notification_embeddings (
  key TEXT PRIMARY KEY,
  task_name TEXT NOT NULL,
  status TEXT NOT NULL,
  message_text TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  window_minutes INTEGER NOT NULL DEFAULT 60
);

CREATE INDEX IF NOT EXISTS idx_notification_embeddings_task ON notification_embeddings(task_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_embeddings_created ON notification_embeddings(created_at DESC);

-- Спринт 36.1 (durable DAG): запуск как единица выполнения.
-- Строка создаётся до старта шагов и переживает сбой процесса — это основа
-- для resume в 36.2. Статусы: pending → running → passed/failed/cancelled.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_name TEXT NOT NULL,
  status TEXT NOT NULL,
  parent_run_id TEXT,
  workspace_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, started_at DESC);

-- Спринт 36.1: шаг запуска. Поле attempt позволяет повторить шаг, не теряя
-- историю предыдущих попыток; idempotency_key защищает от повторного
-- выполнения того же шага (36.3). Статусы: pending → running → passed/failed/skipped.
CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_name TEXT NOT NULL,
  -- Порядок шага в линейной цепочке (36.2): 0, 1, 2... Стабилен для resume.
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT,
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  output_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, step_name)
);

CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_steps_status ON run_steps(status);

-- Спринт 36.4 (DLQ): шаги, которые упали детерминированно (исчерпали попытки),
-- ждут ручного retry или отказа. Открытая запись на шаг может быть только одна,
-- поэтому ручной retry не создаёт дублей.
CREATE TABLE IF NOT EXISTS run_dlq (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_dlq_status ON run_dlq(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_dlq_open_unique
  ON run_dlq(run_id, step_name) WHERE status = 'open';

-- Спринт 36.5.b (Capability Map): исходы гейта по типам задач.
-- Слой 2 роутера читает success_rate и avg_* и выбирает local/cloud/review
-- без вызова модели. last_10_runs — JSON-массив 1 (гейт пройден) / 0 (провал).
CREATE TABLE IF NOT EXISTS capability_map (
  task_type TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  runs_total INTEGER NOT NULL DEFAULT 0,
  runs_passed INTEGER NOT NULL DEFAULT 0,
  success_rate REAL NOT NULL DEFAULT 0,
  avg_cost_usd REAL NOT NULL DEFAULT 0,
  avg_time_ms REAL NOT NULL DEFAULT 0,
  last_10_runs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capability_success ON capability_map(success_rate DESC);
`;

interface SchemaDb {
  exec(sql: string): void;
  prepare(sql: string): { all(): unknown[] };
}

/**
 * Текущая версия схемы БД (`PRAGMA user_version`).
 *
 * Версия пишется в заголовок SQLite-файла без отдельной таблицы, поэтому
 * переживает пересоздание соединения и видна до применения каких-либо
 * миграций. Увеличивайте при добавлении новой ступени в {@link MIGRATIONS}
 * и добавляйте соответствующую запись в массив.
 */
export const SCHEMA_VERSION = 6;

/** Возвращает сохранённую версию схемы (0 у legacy-БД без user_version). */
export function getSchemaVersion(db: SchemaDb): number {
  const rows = db.prepare("PRAGMA user_version").all() as { user_version?: number }[];
  const value = rows[0]?.user_version;
  return typeof value === "number" ? value : 0;
}

/**
 * Ступени миграции: `to` — целевая версия, `migrate` — изменения.
 *
 * Каждая ступень идемпотентна (проверяет PRAGMA table_info), поэтому её
 * безопасно повторно прогонять на legacy-БД, где user_version ещё равен 0,
 * но колонки уже добавлены прошлыми запусками.
 */
const MIGRATIONS: { to: number; migrate: (db: SchemaDb) => void }[] = [
  {
    // Ступень 1 — состояние Спринта 25: колонки, добавленные ad-hoc ALTER'ами
    // до появления версионирования (Спринты 12/15/21/25).
    to: 1,
    migrate(db) {
      const columns = db.prepare("PRAGMA table_info(history)").all() as {
        name?: string;
      }[];
      const columnNames = columns.map((c) => c.name).filter(Boolean);
      if (!columnNames.includes("workspace_id")) {
        db.exec("ALTER TABLE history ADD COLUMN workspace_id TEXT");
      }
      if (!columnNames.includes("allowed_tools")) {
        db.exec("ALTER TABLE history ADD COLUMN allowed_tools TEXT");
      }
      if (!columnNames.includes("denied_tools")) {
        db.exec("ALTER TABLE history ADD COLUMN denied_tools TEXT");
      }

      // Спринт 15: флаги matrix на tasks (клоны и родитель-шаблон).
      const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as {
        name?: string;
      }[];
      const taskColumnNames = taskColumns.map((c) => c.name).filter(Boolean);
      if (!taskColumnNames.includes("matrix_parent_id")) {
        db.exec("ALTER TABLE tasks ADD COLUMN matrix_parent_id TEXT");
      }
      if (!taskColumnNames.includes("is_matrix_parent")) {
        db.exec("ALTER TABLE tasks ADD COLUMN is_matrix_parent INTEGER DEFAULT 0");
      }

      // Спринт 21: env-переменные на workspace (пары ключ-значение и .env-файл).
      const workspaceColumns = db.prepare("PRAGMA table_info(workspaces)").all() as {
        name?: string;
      }[];
      const workspaceColumnNames = workspaceColumns.map((c) => c.name).filter(Boolean);
      if (!workspaceColumnNames.includes("env_json")) {
        db.exec("ALTER TABLE workspaces ADD COLUMN env_json TEXT");
      }
      if (!workspaceColumnNames.includes("env_file")) {
        db.exec("ALTER TABLE workspaces ADD COLUMN env_file TEXT");
      }

      // Спринт 25: partial вынесен из error, чтобы дашборд не смешивал
      // частичные выполнения с ошибками и таймаутами.
      const metricsColumns = db.prepare("PRAGMA table_info(metrics)").all() as {
        name?: string;
      }[];
      const metricsColumnNames = metricsColumns.map((c) => c.name).filter(Boolean);
      if (!metricsColumnNames.includes("partial")) {
        db.exec("ALTER TABLE metrics ADD COLUMN partial INTEGER DEFAULT 0");
      }
    },
  },
  {
    // Ступень 2 — Спринт 36.1: durable DAG. Таблицы создаются идемпотентно,
    // чтобы legacy-БД (user_version = 0/1) получила их и индексы при обновлении,
    // а не только при создании файла с нуля.
    to: 2,
    migrate(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          task_name TEXT NOT NULL,
          status TEXT NOT NULL,
          parent_run_id TEXT,
          workspace_id TEXT,
          started_at TEXT,
          finished_at TEXT,
          error TEXT,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_name, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, started_at DESC);

        CREATE TABLE IF NOT EXISTS run_steps (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          step_name TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 1,
          idempotency_key TEXT,
          started_at TEXT,
          finished_at TEXT,
          error TEXT,
          output_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(run_id, step_name)
        );
        CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_run_steps_status ON run_steps(status);
        CREATE INDEX IF NOT EXISTS idx_run_steps_key ON run_steps(run_id, idempotency_key);
      `);
    },
  },
  {
    // Ступень 3 — Спринт 36.2: явный порядок шага в линейной цепочке.
    // created_at может совпасть у шагов одной транзакции, поэтому resume
    // не может опираться на время; position фиксирует порядок создания.
    to: 3,
    migrate(db) {
      if (!tableColumns(db, "run_steps").includes("position")) {
        db.exec("ALTER TABLE run_steps ADD COLUMN position INTEGER NOT NULL DEFAULT 0");
        // Для уже существующих строк порядок = порядок вставки (rowid).
        db.exec("UPDATE run_steps SET position = rowid");
      }
    },
  },
  {
    // Ступень 4 — Спринт 36.3: ключ идемпотентности уникален в пределах запуска.
    // Дубли (если были) обнуляются, оставляем первый по rowid; затем старый
    // неуникальный индекс заменяется частичным уникальным.
    to: 4,
    migrate(db) {
      db.exec(`UPDATE run_steps SET idempotency_key = NULL
        WHERE idempotency_key IS NOT NULL
          AND rowid NOT IN (
            SELECT MIN(rowid) FROM run_steps
             WHERE idempotency_key IS NOT NULL
             GROUP BY run_id, idempotency_key
          )`);
      db.exec("DROP INDEX IF EXISTS idx_run_steps_key");
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_run_steps_key_unique
        ON run_steps(run_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
    },
  },
  {
    // Ступень 5 — Спринт 36.4: DLQ для детерминированно упавших шагов.
    // Таблица и индексы идемпотентны; уникальный открытый индекс не даёт
    // завести вторую запись на тот же шаг после ручного retry.
    to: 5,
    migrate(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS run_dlq (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          step_name TEXT NOT NULL,
          status TEXT NOT NULL,
          reason TEXT,
          error TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          resolved_at TEXT,
          resolution TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_run_dlq_status ON run_dlq(status, created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_run_dlq_open_unique
          ON run_dlq(run_id, step_name) WHERE status = 'open';
      `);
    },
  },
  {
    // Ступень 6 — Спринт 36.5.b: Capability Map роутера. Таблица только
    // добавляется, поэтому ступень идемпотентна и безопасна для старых БД.
    to: 6,
    migrate(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS capability_map (
          task_type TEXT PRIMARY KEY,
          model TEXT NOT NULL,
          runs_total INTEGER NOT NULL DEFAULT 0,
          runs_passed INTEGER NOT NULL DEFAULT 0,
          success_rate REAL NOT NULL DEFAULT 0,
          avg_cost_usd REAL NOT NULL DEFAULT 0,
          avg_time_ms REAL NOT NULL DEFAULT 0,
          last_10_runs TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_capability_success ON capability_map(success_rate DESC);
      `);
    },
  },
];

/** Имена колонок таблицы (пустой массив, если таблицы нет). */
function tableColumns(db: SchemaDb, table: string): string[] {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name?: string }[];
  return columns.map((column) => column.name).filter((name): name is string => Boolean(name));
}

/**
 * Применяет схему к открытому соединению.
 *
 * CREATE TABLE IF NOT EXISTS не добавляет новые колонки в уже существующие
 * таблицы, поэтому структурные изменения идут отдельными ступенями миграции
 * после проверки PRAGMA table_info. Это безопасно и для старых БД Спринта 12.
 *
 * После успешных миграций версия фиксируется в `PRAGMA user_version`, чтобы
 * будущие ступени могли выполняться инкрементально, а не перебирать колонки.
 */
export function applySchema(db: SchemaDb): void {
  db.exec(SCHEMA_SQL);

  const fromVersion = getSchemaVersion(db);
  for (const step of MIGRATIONS) {
    if (fromVersion < step.to) {
      step.migrate(db);
    }
  }

  // Индекс по position нельзя объявлять в SCHEMA_SQL: на старой БД таблица
  // run_steps ещё без этой колонки, и CREATE INDEX упал бы до миграции.
  // Поэтому создаём его после миграций — заодно лечим БД, где индекс потерян.
  db.exec("CREATE INDEX IF NOT EXISTS idx_run_steps_position ON run_steps(run_id, position)");

  if (fromVersion !== SCHEMA_VERSION) {
    // PRAGMA не принимает параметры — подставляем проверенное число.
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}
