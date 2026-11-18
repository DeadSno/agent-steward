# 跨平台：Windows → macOS → Linux

插件已不再绑定 `schtasks`。调度器被抽象成一层接口，有三种实现，运行包装脚本按目标操作系统生成。

Translations: [English](../CROSS_PLATFORM.md) · [Русский](CROSS_PLATFORM.ru.md)

## 架构

```
src/
  index.ts                     # 工具、RPC、插件生命周期
  gui.tsx                      # GUI 面板（标题来自 RPC）
  server.ts                    # Web 仪表盘（动态标题）
  core/
    scheduler/
      types.ts                 # SchedulerBackend、CreateTaskOptions、RunTaskResult
      index.ts                 # 工厂 createSchedulerBackend() + getSchedulerTitle()
      windows.ts               # WindowsScheduler  (schtasks)
      linux.ts                 # LinuxScheduler    (crontab)
      mac.ts                   # MacScheduler      (launchd / LaunchAgents)
      posix.ts                 # Linux/macOS 共享基类（任务注册表）
      registry.ts              # POSIX 后端的持久化任务注册表
      logs.ts                  # 跨平台任务日志读取
    wrappers/
      bash.ts                  # Linux/macOS 的 .sh 包装脚本生成器
    ps-wrapper.ts              # Windows 的 .ps1/.cmd 包装脚本（未变）
    record-history.ts          # 指标/历史 + 重试/链式任务（通过后端）
    cron-to-schtasks.ts        # cron → schtasks（仅 Windows）
```

### 接口

```ts
interface SchedulerBackend {
  readonly platform: NodeJS.Platform;
  readonly title: string;              // "Windows 任务计划程序" / "OpenCode Scheduler"
  createTask(options: CreateTaskOptions): Promise<void>;
  deleteTask(name: string): Promise<void>;
  runTask(name: string): Promise<RunTaskResult>;
  listTasks(): Promise<ScheduledTaskInfo[]>;
  pauseTask(name: string): Promise<void>;
  resumeTask(name: string): Promise<void>;
}
```

工厂按 `process.platform` 选择实现：
`win32 → WindowsScheduler`，`darwin → MacScheduler`，其余 → `LinuxScheduler`。

## 各操作系统的运行方式

### Windows（行为未变）
- 任务通过 `schtasks` 注册到 Windows 任务计划程序的 `\OpenCode\agent-steward\` 文件夹（配置文件使用 `\OpenCode\agent-steward-<profile>\`）。旧的 `\OpenCode\windows-scheduler\` 文件夹仍会被读取、重命名和按需删除。
- 包装脚本：`run-task.ps1` 加每个任务专属的 `run-<name>.cmd`，位于 `%APPDATA%\opencode\agent-steward\wrapper`。旧的 `%APPDATA%\opencode\windows-scheduler` 目录会在首次启动时迁移。
- 日志：`%APPDATA%\opencode\agent-steward\logs\<name>.log`。
- cron 会转换成 schtasks（`convertCronToSchTasks`）——支持与之前相同的模板集合。

### Linux
- 任务保存在受管 `crontab` 块中：
  ```
  # >>> opencode-scheduler:agent-steward >>>
  # task: my-task
  */5 * * * * /bin/bash '/…/wrapper/run-my-task.sh' >> '/…/logs/my-task.log' 2>&1
  # <<< opencode-scheduler:agent-steward <<<
  ```
  不带 `:<folder>` 后缀的旧块仍会被读取和删除。
- 暂停 = 带 `# PAUSED: ` 前缀的行（块会从注册表重建）。
- `file` 触发器的任务不会进入 crontab——由插件的 FileWatchManager 启动。
- 包装脚本：`~/.config/opencode/agent-steward/wrapper/run-<name>.sh`（chmod 0755）。
- 支持完整 cron 语法（与 Windows 不同），因为 crontab 原生支持。
- 一次性任务（`once`）：使用 `at -t`；如果未安装 `at`，插件会退回到分离的 `sleep && 命令` 进程（注册表中为 `pid:<pid>`）。回退方案无法在重启后保留，建议安装 `at` 包。
- 删除/重建只触及自己的块，`crontab` 的其他行不受影响。
- 未闭合的插件块（只有开始标记）按 fail-closed 处理：插件报告错误且不重写 crontab，因此标记之后的用户行不会丢失。

### macOS
- 任务是 LaunchAgent plist：`~/Library/LaunchAgents/com.opencode.scheduler.<name>.plist`。
- 调度：`* * * * *` 和 `*/N` 使用 `StartInterval`，`M * * * *`、`M H * * *`、`M H * * D`
  使用 `StartCalendarInterval`。
- 暂停 = `launchctl unload -w`，恢复 = `launchctl load -w`。
- 安装已暂停的任务只写入 plist，不调用 `load -w`（它会清除暂停）；
  `unload -w` 保证代理在下次登录后仍保持禁用。
- `launchctl load` 的错误不会被吞掉：安装/恢复失败会带上命令、退出码和
  stderr（例如损坏的 plist 返回 `Invalid property list`）。
- 包装脚本与 Linux 相同的 `.sh`；配置路径：
  `~/.config/opencode/agent-steward/`（或 `$XDG_CONFIG_HOME`）。

### 共享 POSIX 包装脚本（`.sh`）
- `cd` 到工作目录，用文件中的提示词执行 `opencode run`。
- 日志通过 `>>` 追加，并带时间戳。
- 通过原子 `mkdir` 加锁——防止并行运行。
- Node、PS 和 bash 都将锁持有者写为 `<pid>-<iso>`；旧格式 `<iso>|<pid>`（PS）和
  裸 `<pid>` 仍可读取，因此运行中的锁不会被另一种运行时误判为过期。
- 插件启动时同时读取 `<task>.lock` 与 `<task>.lock.d/pid` 的持有者：只有 PID
  已死亡或缺失时才清理锁目录，年龄仅作为回退条件。
- 超时：子进程 + 看门狗（先 `TERM`，再 `KILL`）。
- Quality Gate：`bash -lc "<命令>"`（相当于 Windows 上的 `cmd.exe /c`）。
- 指标：`node "<record-history.js>" <task> <status> <started> <duration> <error> "-" "-"`——
  与 PowerShell 包装脚本相同的契约，因此历史/指标/重试/链式任务在各平台通用。
- `PATH` 追加 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/.bun/bin`。

## 功能矩阵

| 能力 | Windows | Linux | macOS |
|---|---|---|---|
| 调度后端 | `schtasks` | `crontab` | `launchd` LaunchAgents |
| 原生 cron 子集 | `* * * * *`、`*/N * * * *`（N ≤ 1439，60 % N = 0）、`M * * * *`、`M H * * *`、`M H * * D` | 完整 cron | 与 Windows 相同的子集 |
| 其他 cron 表达式 | 分钟轮询 + schedule gate | 原生 cron | 分钟轮询 + schedule gate |
| 月/周字段中的 `*/N` | 非原生 → 轮询 | 原生 | 非原生 → 轮询 |
| 暂停 / 恢复 | `schtasks /change /disable` / `/enable` | 托管块中的 `# PAUSED:` 行 | `launchctl unload -w` / `load -w` |
| 文件触发器 | 进程内 `FileWatchManager` | 相同 | 相同 |
| 任务包装脚本 | `.cmd` + `.ps1` | `.sh` | `.sh` |
| 日志 | `%APPDATA%\opencode\agent-steward\logs` | `~/.config/opencode/agent-steward/logs` | 与 Linux 相同 |
| `secrets.key` 保护 | `icacls`（仅所有者）+ `chmod` 回退 | `chmod 0600` | `chmod 0600` |
| 仪表盘 | `127.0.0.1`，动态标题 | 相同 | 相同 |
| DAG / matrix / quality gates / 通知 | 插件内，与操作系统无关 | 相同 | 相同 |

### 折衷

1. **分钟轮询。** 原生子集之外的 cron 表达式，以及使用非系统 IANA 时区的任务，
   由操作系统调度器每分钟启动一次；`schedule-gate` 决定是否真正执行。
   代价是每个任务每分钟一个短生命周期的包装进程。
2. **`M H */N * *` 故意不转换为 `schtasks /sc DAILY /mo N`。**
   cron 从每月 1 日开始计数，并在月初重置；`/mo N` 从任务创建日期开始计数，
   不会在月初重置。两者并不等价，因此该表达式保持轮询模式。
   若要原生支持，应使用 `MONTHLY` 加显式 `/d` 列表，而不是 `DAILY /mo N`。
3. **DST。** 网关按本地墙上时间工作。不存在的时间（春季前进）会被跳过；
   有歧义的时间（秋季回拨）在第一次出现时执行。
4. **Windows 上的 `*/N * * * *`** 仅在 `60 % N = 0` 且 `N ≤ 1439` 时原生支持。
   否则回退到轮询：`schtasks /mo N` 从创建时刻计数，而 cron 从整点开始计数。
5. **POSIX 包装脚本、crontab 和 launchd 尚未在真实 Linux/macOS 主机上执行**
   （见“限制”）；语法和转义仅由测试覆盖。

## GUI 与仪表盘
- 标题是动态的：Windows 上为「Windows 任务计划程序」，macOS/Linux 上为「OpenCode Scheduler」。
- 标题来自 RPC 方法 `get_platform` → `{ platform, title }`。
- 标题同时用于 GUI 面板、错误回退面板和仪表盘的 `<title>/<h1>`。
- 按钮、状态、表格、DAG 和指标与操作系统无关。
- 工具描述（`schedule_task` 等）会替换为实际调度器名称。

## 构建与检查
- `npm run build` — 通过，无错误。
- `npm run build:gui` — 通过（`gui-experimental.cjs`，约 47.7 kB）。
- 运行时已验证：
  - win32/darwin/linux 的标题；
  - 多个表达式上的 `cronToLaunchdSchedule`；
  - Windows 上真实的 `listTasks()`——返回短任务名（无前缀）；
  - `shellQuote` 转义（引号、空格、西里尔字母）；
  - `dist/index.js` 可导入，`dist` 不直接引用 `schtasks.js`。

## 限制与需要在真实机器上验证的内容
1. `.sh` 包装脚本和 crontab/launchd **从未实际执行**——当前 Windows 机器没有 `bash`/WSL。
   语法和转义是手工检查的；仍需在 Linux 和 macOS 上跑一遍。
2. cron → launchd 支持与 Windows 相同的有限模板集合
   （`* * * * *`、`*/N * * * *`、`M * * * *`、`M H * * *`、`M H * * D`）。
   Linux 上支持完整 cron。
3. Windows 任务前缀现为 `\OpenCode\agent-steward\`（旧的 `\OpenCode\windows-scheduler\` 仍会被识别）；插件 id 为向后兼容而保留。
4. `src/schtasks.ts` 保留为旧脚本（`test-create.cjs`、`test-run.cjs`）的薄垫片；
   所有逻辑现在都在 `core/scheduler/windows.ts`。
