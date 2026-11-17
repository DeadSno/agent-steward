/** @jsxImportSource @opentui/solid */
import type {
  TuiCommand,
  TuiDialogSelectOption,
  TuiPlugin,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import { getSchedulerBackend } from "./core/scheduler/index"
import { getTaskLogs } from "./core/scheduler/logs"
import {
  formatJobLog,
  getJobsView,
  groupJobsForDisplay,
  nextJobSelection,
  statusIcon,
  type JobView,
} from "./shared/jobs-view"

const PLUGIN_ID = "opencode-windows-scheduler.tui"
const ROUTE_NAME = "scheduler"
const GROUP = "Планировщик Windows"
const SELECTED_KEY = "opencode-windows-scheduler.selected"

type JobAction = "run" | "pause" | "resume" | "log"

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * TUI-часть для OpenCode V1 (>= 1.18.29).
 *
 * V1 не даёт reactive store, поэтому панель в сайдбаре — снимок на момент
 * регистрации слота. Полноценная интерактивная панель живёт на маршруте
 * `/scheduler`: после каждого обновления маршрут перерегистрируется, а если он
 * открыт — перерисовывается через `navigate`.
 *
 * V1-слот называется `sidebar_content` (в V2 — `sidebar.content`).
 */
export const tuiV1: TuiPlugin = async (api) => {
  let jobs: JobView[] = await getJobsView(api)
  let selected =
    api.kv.get<string>(SELECTED_KEY, "") ||
    groupJobsForDisplay(jobs)[0]?.job.name ||
    ""
  let disposed = false
  let unregisterRoute: (() => void) | undefined

  function rows() {
    return groupJobsForDisplay(jobs)
  }

  function panel() {
    return (
      <box flexDirection="column">
        <text>Планировщик Windows</text>
        {jobs.length === 0 ? (
          <text>Задач пока нет</text>
        ) : (
          rows().map(({ job, depth }) => (
            <text onMouseDown={() => void openActions(job)}>
              {selected === job.name ? "› " : "  "}
              {"  ".repeat(depth)}
              {depth > 0 ? "↳ " : job.isMatrixParent ? "▣ " : ""}
              {statusIcon(job.status)} {job.name}
              {job.paused ? " (пауза)" : ""}
              {job.nextRun ? ` → ${job.nextRun}` : ""}
            </text>
          ))
        )}
        <text>Клик — действия · Ctrl+Shift+J — меню</text>
        <text>Ctrl+Shift+↑/↓ — выбор · Ctrl+Shift+Enter — открыть</text>
      </box>
    )
  }

  /**
   * V1 не умеет отписываться от слота, но умеет перерегистрировать маршрут.
   * Поэтому все обновления идут через маршрут, а слот остаётся статичным.
   */
  function registerRoute(): void {
    unregisterRoute?.()
    unregisterRoute = api.route.register([
      { name: ROUTE_NAME, render: () => panel() },
    ])
  }

  function redrawRoute(): void {
    registerRoute()
    if (api.route.current.name === ROUTE_NAME) {
      api.route.navigate(ROUTE_NAME)
    }
  }

  function persistSelection(): void {
    api.kv.set(SELECTED_KEY, selected)
  }

  async function refresh(): Promise<void> {
    try {
      const next = await getJobsView(api)
      if (disposed) return
      jobs = next
      if (!jobs.some((job) => job.name === selected)) {
        selected = rows()[0]?.job.name ?? ""
        persistSelection()
      }
      redrawRoute()
    } catch {
      // Планировщик может быть временно недоступен — оставляем прошлый снимок.
    }
  }

  function showAlert(title: string, message: string): void {
    const close = () => api.ui.dialog.clear()
    api.ui.dialog.replace(
      () => (
        <api.ui.Dialog size="large" onClose={close}>
          <api.ui.DialogAlert title={title} message={message} onConfirm={close} />
        </api.ui.Dialog>
      ),
      close
    )
  }

  function choose<Value>(
    title: string,
    options: TuiDialogSelectOption<Value>[]
  ): Promise<Value | undefined> {
    return new Promise((resolve) => {
      let settled = false
      const done = (value?: Value) => {
        if (settled) return
        settled = true
        api.ui.dialog.clear()
        resolve(value)
      }
      api.ui.dialog.replace(
        () => (
          <api.ui.Dialog size="medium" onClose={() => done(undefined)}>
            <api.ui.DialogSelect<Value>
              title={title}
              placeholder="Выберите"
              options={options}
              onSelect={(option) => done(option.value)}
            />
          </api.ui.Dialog>
        ),
        () => done(undefined)
      )
    })
  }

  async function showLog(job: JobView): Promise<void> {
    try {
      const result = await getTaskLogs(job.name, 200)
      showAlert(`Лог: ${job.name}`, formatJobLog(result.logs, result.error, 40))
    } catch (err) {
      api.ui.toast({
        title: GROUP,
        message: `Не удалось прочитать лог «${job.name}»: ${errorText(err)}`,
        variant: "error",
      })
    }
  }

  async function runAction(job: JobView, action: JobAction): Promise<void> {
    try {
      if (action === "log") {
        await showLog(job)
        return
      }
      const backend = getSchedulerBackend()
      if (action === "run") {
        const result = await backend.runTask(job.name)
        api.ui.toast({
          title: GROUP,
          message: result.alreadyRunning
            ? `«${job.name}» уже выполняется`
            : `Запущено: ${job.name}`,
          variant: result.alreadyRunning ? "warning" : "success",
        })
      } else {
        const shouldPause = action === "pause"
        if (shouldPause) await backend.pauseTask(job.name)
        else await backend.resumeTask(job.name)
        api.ui.toast({
          title: GROUP,
          message: shouldPause ? `Пауза: ${job.name}` : `Возобновлено: ${job.name}`,
          variant: "success",
        })
      }
      await refresh()
    } catch (err) {
      api.ui.toast({
        title: GROUP,
        message: `Не удалось выполнить действие для «${job.name}»: ${errorText(err)}`,
        variant: "error",
      })
    }
  }

  async function openActions(job: JobView): Promise<void> {
    const options: TuiDialogSelectOption<JobAction>[] = [
      {
        title: "▶ Запустить сейчас",
        value: "run",
        description: job.matrixParentId
          ? "Клон матрицы запускается через родительскую задачу"
          : job.status === "running"
            ? "Задача уже выполняется"
            : "Запустить задачу немедленно",
        disabled: Boolean(job.matrixParentId),
      },
      {
        title: job.paused ? "▶ Возобновить" : "⏸ Поставить на паузу",
        value: job.paused ? "resume" : "pause",
        description: job.paused
          ? "Снять задачу с паузы в планировщике ОС"
          : "Приостановить запуски в планировщике ОС",
      },
      {
        title: "📜 Показать лог",
        value: "log",
        description: "Последние 40 строк вывода задачи",
      },
    ]

    const action = await choose<JobAction>(`Задача: ${job.name}`, options)
    if (!action || disposed) return
    await runAction(job, action)
  }

  async function chooseJob(): Promise<void> {
    if (jobs.length === 0) {
      api.ui.toast({ title: GROUP, message: "Задач пока нет", variant: "warning" })
      return
    }
    const name = await choose<string>(
      "Планировщик: выберите задачу",
      rows().map(({ job, depth }) => ({
        title: `${"  ".repeat(depth)}${job.isMatrixParent ? "▣ " : depth > 0 ? "↳ " : ""}${job.name}`,
        value: job.name,
        description: `${statusIcon(job.status)}${job.paused ? " пауза" : ""}${
          job.nextRun ? ` · следующий запуск: ${job.nextRun}` : ""
        }`,
      }))
    )
    if (!name || disposed) return
    const job = jobs.find((item) => item.name === name)
    if (job) await openActions(job)
  }

  function moveSelection(delta: number): void {
    const name = nextJobSelection(rows(), selected, delta)
    if (!name) return
    selected = name
    persistSelection()
    redrawRoute()
  }

  function openSelected(): void {
    const job = jobs.find((item) => item.name === selected)
    if (job) void openActions(job)
  }

  registerRoute()

  // Слот V1 статичен: политика API не даёт его перерегистрировать.
  // Полный обновляемый список доступен на маршруте /scheduler.
  api.slots.register({
    slots: {
      sidebar_content: () => panel(),
    },
  })

  const disposeCommands = api.command?.register(
    (): TuiCommand[] => [
      {
        title: "Планировщик: действия с задачей",
        value: "opencode-windows-scheduler.actions",
        description: "Запустить, поставить на паузу или возобновить задачу",
        category: GROUP,
        keybind: "ctrl+shift+j",
        onSelect: () => chooseJob(),
      },
      {
        title: "Планировщик: открыть панель",
        value: "opencode-windows-scheduler.open-panel",
        description: "Открыть список задач на весь экран",
        category: GROUP,
        onSelect: () => api.route.navigate(ROUTE_NAME),
      },
      {
        title: "Планировщик: обновить список",
        value: "opencode-windows-scheduler.refresh",
        category: GROUP,
        onSelect: () => refresh(),
      },
      {
        title: "Планировщик: предыдущая задача",
        value: "opencode-windows-scheduler.previous",
        category: GROUP,
        keybind: "ctrl+shift+up",
        onSelect: () => moveSelection(-1),
      },
      {
        title: "Планировщик: следующая задача",
        value: "opencode-windows-scheduler.next",
        category: GROUP,
        keybind: "ctrl+shift+down",
        onSelect: () => moveSelection(1),
      },
      {
        title: "Планировщик: действия с выбранной задачей",
        value: "opencode-windows-scheduler.open-selected",
        category: GROUP,
        keybind: "ctrl+shift+enter",
        onSelect: () => openSelected(),
      },
    ]
  )

  const timer = setInterval(() => {
    void refresh()
  }, 5000)
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    ;(timer as { unref?: () => void }).unref?.()
  }

  api.lifecycle.onDispose(() => {
    disposed = true
    clearInterval(timer)
    unregisterRoute?.()
    disposeCommands?.()
  })
}

const moduleDefinition: TuiPluginModule = { id: PLUGIN_ID, tui: tuiV1 }

export default moduleDefinition
