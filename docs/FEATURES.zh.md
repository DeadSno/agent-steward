# 功能

Translations: [English](FEATURES.md).

调度器全部能力的完整目录，附带示例以及实践中真正要紧的注意事项。

- [调度](#调度)
- [执行策略](#执行策略)
- [编排](#编排)
- [多仓库工作区](#多仓库工作区)
- [配置档案（多项目）](#配置档案多项目sprint-21)
- [工作区环境变量](#工作区环境变量sprint-21)
- [可观测性](#可观测性)
- [管理](#管理)
- [Agent 接口](#agent-接口)
- [平台支持](#平台支持)
- [限制与非目标](#限制与非目标)

## 调度

### Cron 计划

五字段 cron：`minute hour day-of-month month day-of-week`。每个字段都支持列表、范围与步进（`0 8-10,18 * * 1-5/2`）、月份和星期名称（`0 9 * * MON-FRI`）、`@every` 语法糖（`@every 15m`、`@every 2h`、`@every 1d`）、表示当月最后一天的 `L`，以及 `d#n` 第 n 个星期几的形式（`0 9 * * FRI#3`）。

| 模式 | 示例 | 含义 |
| --- | --- | --- |
| 每 N 分钟 | `*/15 * * * *` | 每 15 分钟 |
| 固定时间 | `0 9 * * *` | 每天 09:00 |
| 工作日 | `30 8 * * 1-5` | 周一至周五 08:30 |
| 每月 | `0 3 1 * *` | 1 日 03:00 |
| 最后一天 | `0 3 L * *` | 当月最后一日 03:00 |
| 第 N 个星期几 | `0 9 * * FRI#3` | 第三个周五 09:00 |
| 语法糖 | `@every 15m` | 每 15 分钟 |

Windows 后端会把简单的 cron 表达式转换为原生任务计划程序触发器。`schtasks` 无法表达的表达式（`L`、`#`、复杂列表），以及时区不同于系统时区的任务，都以轮询模式注册：操作系统任务每分钟唤醒一次包装器，由 `schedule-gate` 决定 agent 是否运行。

### 一次性运行

`triggerType: "once"` 让任务在某一特定时刻恰好运行一次。可以使用 `runAt`（ISO-8601，或本地日期字符串如 `2026-11-13 22:40`）或 `delaySeconds`（从现在起的延迟）：

```json
{
  "name": "deploy-once",
  "triggerType": "once",
  "runAt": "2026-11-13T22:40:00+03:00",
  "prompt": "Deploy the current main branch."
}
```

```json
{ "name": "remind-later", "triggerType": "once", "delaySeconds": 3600, "prompt": "..." }
```

两者同时存在时以 `runAt` 为准。`schedule` 被忽略。一次性任务以原生方式注册（`schtasks /sc ONCE`、Linux `at`、macOS launchd 清理代理），插件重启后不会重复运行，而且无法与

> **Windows 区域设置说明。** `schtasks /sd` 只接受当前 Windows 区域设置格式的日期。
> 插件生成 `DD.MM.YYYY`，与俄语（以及大多数欧洲）区域设置匹配。在英语/美式区域
> 设置（`MM/DD/YYYY`）的系统上 `schtasks` 会拒绝该日期，因此那里无法使用一次性
> 任务。
矩阵（matrix）组合。

### 会话连续性

每次计划运行既可以选择开启全新的 OpenCode 会话（`new`，默认），也可以复用存储在任务上的持久会话，或继续最近一次会话（`last`，对应 `opencode --continue`）。在任务上设置 `session`；对于 `reuse`，会自动生成 `sessionId` 并随任务定义一起存储——它永远不会从用户输入接收，也不会以明文导出。

```json
{
  "name": "nightly-analyst",
  "schedule": "0 3 * * *",
  "session": "reuse",
  "sessionMaxRuns": 10,
  "prompt": "Refresh the analysis."
}
```

- `session`：`new`（默认）、`reuse`（传入 `--session <id>`）、`last`（传入 `--continue`）。
- `sessionMaxRuns`（仅用于 `reuse`）：复用的会话在被删除（`opencode session delete`）并
  启动新会话之前可以存活多少次运行。未设置/0 表示不限制。
- `sessionId` 按机器/配置档案独立存在。内部运行计数器
  （`sessionRunCount`）永不导出。
- 不带会话字段的旧导出/导入文件会以 `new` 导入。

### 时区与启动窗口

- `timezone` — 每个任务的 IANA 时区（例如 `Europe/Moscow`）。`nextRun`/`prevRun`、
  试运行的下次运行预估以及闸门都在该时区内计算 cron；夏令时切换会被处理
  （春季跳变中不存在的时间会被跳过）。
- `notBefore` / `notAfter` — 以 `HH:MM` 表示的每日启动窗口（可以跨午夜，
  例如 `22:00`–`06:00`）。在窗口之外触发的运行会被**推迟**
  到窗口开启之时（通过延迟文件，推迟一次），而不是被跳过。
- `activeDays` — 允许的星期 `0`=周日 … `6`=周六（Sprint 27）。留空或
  七天全选表示每天。适用于 cron 和事件触发器。
- `windowPolicy` — 窗口之外或在不允许的日子的行为（Sprint 27）：
  `postpone`（默认）等待下一个开启时机（最多 12 小时），`skip` 丢弃
  该次运行，`run` 照常执行。
- `pausedUntil` — 将任务暂停到某一 ISO 时刻。`pause_task` 接受
  `until`；插件在启动时和一个 5 分钟定时器上自动重新启用任务，
  而 `resume_task` 可以提前恢复。

### 文件触发器

```json
{
  "name": "regen-api-client",
  "triggerType": "file",
  "watchPath": "C:\\projects\\api\\openapi.yaml",
  "prompt": "Regenerate the API client from openapi.yaml and run contract tests."
}
```

文件由插件宿主中的 chokidar 监视，变更会被去抖处理。文件触发器忽略 `schedule`。

#### 文件触发器的 Glob 掩码（Sprint 27）

`watchGlobs` 和 `watchIgnore` 限制哪些变更算作触发器：

掩码支持 `*`（不跨 `/`）、`**`（任意段，包括零段）、
`?`（单个字符）、`[abc]` / `[a-z]`（字符类）、`{a,b}`（备选）以及 `!`
（取反）。空的 `watchGlobs` 表示“任何变更”。路径被规范化为 POSIX
形式（`\` → `/`），在 Windows 上比较不区分大小写。

### Git 触发器（Sprint 27）

```json
{
  "name": "deploy-on-push",
  "triggerType": "git",
  "workingDirectory": "C:\\projects\\api",
  "gitBranch": "main, release/*",
  "gitPaths": ["src/**", "package.json"],
  "gitIgnore": ["**/*.md", "CHANGELOG.md"],
  "gitPollSeconds": 60,
  "prompt": "Deploy the changed services to staging."
}
```

带有 `triggerType: "git"` 的任务会在其工作目录中出现新提交时启动。第一次轮询只记住当前的 `HEAD`（基线），不会启动任何东西。之后的轮询比较 `git diff --name-only <last>..HEAD`，当掩码 `gitPaths`（为空——任意文件）匹配且未被 `gitIgnore` 排除时启动任务。过滤器 `gitBranch` 限制分支（逗号分隔，支持 `*` 和 `?`）。

轮询周期 `gitPollSeconds` — 最小 5 秒，默认 60。状态（最近一次处理的提交）存储在 SQLite 表 `git_state` 中，因此插件重启不会导致重复运行。

### MCP 事件触发器

```json
{
  "name": "on-pr-opened",
  "triggerType": "mcp-event",
  "mcpEvent": { "server": "github", "event": "pull_request.opened", "filter": "repo=acme/api" },
  "prompt": "Review the newly opened pull request."
}
```

事件通过 `emit_event` RPC 方法发出。

### 手动运行与暂停

- `run_task_now` 立即启动任务，走同一个包装器（超时、锁、
  钩子、Quality Gate）。
- `pause_task` / `resume_task` 禁用并重新启用操作系统条目。对于矩阵父任务，
  每个克隆都会被暂停。

### 登录模式（Windows）

默认情况下任务**仅以交互方式运行**：任务计划程序只在创建它的用户已登录时运行它。这是安全的默认值——作业可以看到用户配置文件、映射驱动器、项目的 `opencode.json` 和已保存的凭据。

有些作业必须在工作时间之外、或在已锁定/已注销的机器上运行。传入 `runWhenLoggedOff: true`（agent 工具 `schedule_task` / `update_task`，或侧边栏）即可改为以 `schtasks /ru SYSTEM` 注册任务。这样运行发生在会话 0 中，没有用户的配置文件、映射驱动器、网络共享或已保存的凭据。依赖用户环境的任务可能以 `Access is denied` 或文件缺失而失败，因此请先用 `dry_run` 检查，并优先使用绝对路径。

`runWhenLoggedOff` 仅限 Windows：Linux crontab 本来就在没有已登录用户的情况下运行，而 macOS launchd 代理只在用户会话内运行。`list_tasks` 会同时报告操作系统值（`logonMode`）和插件设置（`runWhenLoggedOff`）；`dry_run` 在任务注册之前显示同样的两项。

## 执行策略

### 超时与不重叠

每次运行都有 `timeoutSeconds`（默认 3600）。超时后进程树会被停止，该次运行记录为 `timeout`。锁文件防止同一任务的两次运行重叠；第二次启动会立即退出并记录为 `skipped`。

### 前置检查、Quality Gate、后置检查

```json
{
  "name": "nightly-deps",
  "schedule": "0 2 * * *",
  "beforeScript": "git pull --ff-only",
  "prompt": "Update dependencies, fix breaking changes, keep the diff minimal.",
  "qualityGate": "npm test",
  "afterScript": "git push",
  "timeoutSeconds": 2400
}
```

| 钩子 | 时机 | 非零退出的后果 |
| --- | --- | --- |
| `beforeScript` | agent 启动之前 | 运行被取消，前置检查标记为失败 |
| `qualityGate` | 成功响应之后 | 运行被标记为 Quality Gate 失败（error） |
| `afterScript` | 运行之后，即使失败也执行 | 记入历史，不会把成功改写掉 |

### 重试

`retryCount` 和 `retryDelay`（秒）用于重试失败的运行。重试状态被持久化，因此崩溃不会造成无限重试循环。重试先于链式后续任务和依赖者发生。

### 模型与优先级

`model` 选择一个 OpenCode 模型（例如 `anthropic/claude-3-5-sonnet`）；
省略它则使用 OpenCode 的默认值。`priority` 取值 `0..10`，并透传给
调度器条目。

### 工具限制

基线来自 `permissions.defaultPolicy`：`hybrid`（默认）允许
read/edit/glob/grep/subagent/skill/webfetch/websearch 并拒绝 `shell` 和 `question`，
`secure` 只允许 read/glob/grep/skill，而 `legacy` 恢复 1.5.x 允许一切的行为。任务级
`legacyShell: true` 会在 `hybrid` 下为从旧版本迁移来的作业重新启用 `shell`；
`legacy` 是粗放的替代方案。

> **自治任务与 `tool.blocked`：** 默认的 `hybrid` 策略会拒绝 agent 使用 `shell`
> 和 `question`，因此无人值守任务若尝试运行 `git status`（或询问澄清问题），
> 会在日志中留下 `tool.blocked` 且无法完成该步骤。这是有意设计——不要仅为消除
> 它而全局把 `defaultPolicy` 改成 `legacy`。应当为该具体任务授予能力：把 `shell`
> （确有需要时也包括 `question`）加入该任务的 `allowedTools`，为迁移作业使用
> `legacyShell: true`，或把命令移入 `beforeScript` / `qualityGate` / `afterScript`
> ——它们以你的用户权限运行，不受 agent 工具限制约束。推荐在脚本中执行 shell 命令。

`allowedTools` 和 `deniedTools` 对任务包装器启动的 `opencode run` 进程
强制生效。包装器通过 `OPENCODE_CONFIG_CONTENT` 把生成的 `permissions` 规则
传给该进程；不会向任务工作目录写入任何文件，因此项目级
`opencode.jsonc` 永远不会被覆盖。每个 `deniedTools` 条目都会变成对应
OpenCode 动作的 `effect: "deny"` 规则，而 `allowedTools`（一旦设置）
会拒绝所有未列出的动作。包装器以 `--auto` 运行 `opencode`，所以
只有未被拒绝的权限会被自动批准。限制作用于 agent 进程，
而不作用于钩子、Quality Gate 或脚本——它们仍以你的用户权限运行。精确的动作映射和已知限制（项目/系统配置、
嵌套子代理）见
[ARCHITECTURE.md](ARCHITECTURE.md#permission-enforcement--known-limitations-spike-291-findings)。

### 一次性 git worktree（W-1）

设置 `worktree: true` 后，每次运行都会在 `workingDirectory` 的全新 `git worktree`
中执行，并使用独立的 `agent-steward/...` 分支。包装脚本在调度门禁之后、启动
`opencode` 之前创建 worktree，通过提示词前导和 `AGENT_STEWARD_WORKTREE` 把路径传给
Agent；创建失败时（例如目录不是 git 仓库）运行会 fail-closed 终止。每次运行的路径和
分支都唯一，因此矩阵克隆和并行任务可以各自写文件，互不影响主工作区和彼此——无需
Docker 即可安全扇出。

Worktree 位于 `PLUGIN_DIR/worktrees`，旁边的 `.json` sidecar 用于清理。运行结束后，
包装脚本会删除 worktree 及其 `agent-steward/...` 分支，任务失败时也会删除（W-2.1）。
崩溃留下的残留会在下一次运行时顺带清扫：超过 24 小时的 worktree 被删除，没有工作
副本的 sidecar 被清理，`.cleanup-lock` 串行化并发清扫（W-2.2）。清理只处理 worktree
根目录下带 sidecar 且分支为 `agent-steward/` 的路径，因此不会删除外来目录和正在
运行的 worktree。worktree 不隔离网络、API 或数据库访问，Quality Gate 仍以你的
用户权限运行。

### Guard 条件（W-3）

可以为任务设置 `guards` — 运行前必须满足的条件：可选的 shell `command`
（exit 0 表示通过，非 0 表示跳过，`timeoutSeconds` 1..3600）和/或 `semantic`
条件 — `filesExist` / `filesMissing`（相对路径，在 worktree 或 cwd 内解析）、
`branch`（glob）和 `changedPaths`（glob；`changedSince..HEAD` 的 diff 中至少
匹配一个路径，默认 `HEAD~1`）。所有条件按「与」组合：任一检查失败或出错时，
运行会被优雅跳过，并在历史记录和 GUI 中显示为可见的 `skipped` 状态
（`record-history --skip`；不发送通知、不触发成功/错误链）。检查在创建
worktree 之后执行，因此与 `worktree: true` 组合时它们在新 worktree 内运行；
`guard-run.js` 帮助程序位于 `src/core/guard-run.ts`，`src/core/guard.ts`
提供规范化、求值和退出码约定（4 = 跳过）。

## 编排

### 链式调度

```json
{ "name": "build", "nextTaskOnSuccess": "deploy", "nextTaskOnError": "notify-failure" }
```

一次运行结束后恰好启动一个后续任务。

### DAG 依赖

```json
{ "name": "smoke-tests", "dependsOn": ["deploy"], "schedule": "0 * * * *" }
```

只有当每个依赖的最近一次运行成功时，依赖者才会启动。如果某个依赖是矩阵，则**所有克隆**都必须成功——处于 `partial` 的矩阵会阻塞依赖者。

### 矩阵构建（扇出）

一份定义，每个工作区一个克隆：

```json
{
  "name": "deploy",
  "schedule": "0 3 * * *",
  "prompt": "Build, test and deploy this repository. Report what changed.",
  "matrix": {
    "workspaceIds": ["ws-frontend", "ws-backend", "ws-mobile"],
    "strategy": "parallel",
    "failureMode": "continue",
    "concurrency": 2,
    "overrides": {
      "ws-mobile": { "qualityGate": "flutter test", "prompt": "Use the Flutter toolchain." }
    }
  }
}
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `strategy` | `parallel` | `sequential` 只有在前一个克隆结束后才启动下一个 |
| `failureMode` | `continue` | `stop` 在第一次失败后中止其余克隆 |
| `concurrency` | 无限制 | 同时运行的最大克隆数（`sequential` 时被忽略） |
| `aggregation` | `summary` | `summary` 为父任务写入一条聚合记录 |
| `createAggregator` | `false` | 同时创建依赖每个克隆的 `<parent>-matrix-complete` |
| `overrides` | 无 | 按工作区的 prompt/模型/Quality Gate/钩子 |

值得了解的行为：

- 克隆命名为 `<parent>-matrix-<workspace>`，继承父定义并拥有
  自己的工作目录。
- 父任务从不自己运行；它的状态是聚合值：`success`、`error`、
  `partial`（在 `continue` 下部分克隆失败）或 `running`。
- 编辑父任务（工作区、prompt、覆盖、并发）会**同步**克隆
  集合：缺失的克隆被创建，发生变化的被更新，被移除的被删除。正在
  运行作业的克隆永远不会被改动。
- 取消矩阵（`matrix_control`，`action: "cancel"`）会把待运行的克隆
  标记为已取消并停止正在运行的克隆。删除父任务会删除它的整个家族。
- `matrix_control` 的 `action: "cleanup"` 会移除父任务已不存在的孤立
  克隆；同样的清理也会在插件启动时运行。

### 流水线即代码

整个 DAG 可以声明在 `opencode.pipeline.yaml` 中并按代码应用：

- `version: 1`、流水线 `name`、可选的 `defaults` 和 1..200 个 `steps`。
- 每个步骤有稳定的 `id`、`prompt` 和可选的 `needs`（转换为 `dependsOn`）。
- `trigger: cron`（默认）需要 `schedule`；`trigger: once` 需要 `runAt`；
  `trigger: dag` 只在其 `needs` 成功后运行。
- `matrix.workspaces` 按 workspace 名称或 id 将步骤扇出。
- `agent-steward pipeline validate|apply|export` 与 `pipeline_validate`、
  `pipeline_apply`、`pipeline_export` 工具覆盖整个生命周期；apply 幂等、
  跳过未变化的步骤，且从不删除 stale 任务。
- 完整格式与限制：[PIPELINE.md](PIPELINE.md)。

## 多仓库工作区

工作区是一个命名目录：id、name、path、可选的 git 远程仓库和颜色。

```json
{ "id": "ws-api", "name": "API", "path": "C:\\projects\\api", "color": "#3b82f6" }
```

在工作区中运行任务时使用 `workspaceId` 代替 `workingDirectory`。路径在
添加/更新/导入时会被校验，仪表板按工作区分组任务和运行记录。
工作区是矩阵构建扇出的单位。

## 配置档案（多项目，Sprint 21）

配置档案让你在一个插件内运行多套相互独立的调度器安装，每套都有
自己的 SQLite 数据库、设置、日志、包装器和仪表板端口。这对于
分隔项目、客户或环境（例如 `default` 和 `work`）很有用，
使它们彼此看不到对方的数据。

- 配置档案 `default` 使用插件的基础目录（无需迁移，行为与
  Sprint 21 之前完全一致）。命名配置档案位于 `<base>/profiles/<name>`。
- 配置档案选择顺序：`OPENCODE_SCHEDULER_PROFILE` 环境变量 → 基础目录中的
  `active-profile` 文件 → `default`。切换配置档案会写入标记文件，并且需要
  重启 OpenCode，因为插件目录在模块加载时解析。
- 每个配置档案的仪表板端口：`OPENCODE_SCHEDULER_PORT` 环境变量 → 来自
  `profile.json` 的端口 → 服务器默认值（3782，其次 4782/5782 回退）。新配置档案
  会分配 3783 起的第一个空闲端口，跳过 3782/4782、其他配置档案 `profile.json`
  中已记录的端口以及 `OPENCODE_SCHEDULER_PORT`。
- RPC：`get_profiles` 列出配置档案及其目录、端口和活动标志；
  `set_profile` 切换活动配置档案（会提示重启）；`create_profile` /
  `delete_profile` 管理命名配置档案（`default` 不能被删除）。

### 工作区环境变量（Sprint 21）

每个工作区都可以携带环境变量，它们会被注入到该工作区中的每次任务运行：

- `env` — 显式的 `KEY=VALUE` 对，以 JSON 形式存储在 SQLite 中；
- `envFile` — 可选的 `.env` 文件路径，其变量先被加载，随后
  显式对覆盖它们；
- 文件格式：`KEY=value` 行、`#` 注释、空行、行首 `export `、
  成对引号包裹的值会去掉引号；
- 键名校验：`^[A-Za-z_][A-Za-z0-9_]*$`，每个工作区最多 100 对；
- 传递：在任务创建/更新时，插件把真实值写入
  `<PLUGIN_DIR>/env/<sanitized>.env`（POSIX 上权限 `0600`）并传给
  包装器（Windows：`-EnvFile "<path>"`；POSIX：在调用
  `opencode run` 之前执行 `set -a; . "$ENV_FILE"; set +a`）；
- 密钥遮蔽：匹配 `/(TOKEN|SECRET|PASS|PASSWORD|KEY|CREDENTIAL|AUTH)/i`
  的键在日志和被遮蔽的 API 响应中显示为 `***`——值永远不会泄漏进日志。

## 可观测性

### 历史记录

每次运行都会变成一行记录：状态、开始/结束、时长、错误、token、成本、模型、
前置/后置检查结果、下一个链式任务、工作区和工具限制。状态：

| 状态 | 含义 |
| --- | --- |
| `running` | 已开始，未结束 |
| `success` | 已结束，无 Quality Gate 失败 |
| `error` | agent 错误、钩子失败或 Quality Gate 失败 |
| `timeout` | 被超时终止 |
| `partial` | 既有成功也有失败的矩阵聚合 |

### 指标

按任务的计数器和总计：运行次数、成功、错误、token、成本。可通过
`get_history`、RPC 层和仪表板头部获取。14 天分析切片——
按天分桶（UTC）、成功率、基于 token 的成本估算、按成本排名的热门任务、
矩阵和模型细分——可通过 `get_analytics` /
`GET /api/analytics` 以及仪表板的 **Analytics for the period** 区块获取。
历史记录会自动清理（按时间和大小限制，见设置），并可导出为
CSV/JSON（`GET /api/history/export`），或导出为用于 OpenTelemetry 的
OTLP/JSON（`GET /api/history/export?format=otlp`）。

同一数据切片还带有一个 **"Saved"** 计数器：花费了 token 但
没有记录成本的运行（本地模型、预付套餐）按每 1k token $0.01 的
参考云价格计价。该 KPI 标注为估算值，并链接到
[docs/SAVINGS.md](SAVINGS.md) 的完整方法说明；`report.savings` 暴露
`savedUsd`、`runs`、`tokens` 以及按任务的细分。

每日/每周 **预算**（Economy v2）通过 `manage_settings`
（`budgets: { enabled, dailyUsd, weeklyUsd }`，单位 USD；`0` 表示无限制）
或 `get_settings`/`save_settings` RPC 方法配置。支出按当前 UTC 日 /
UTC 周（周一开始）从已完成的历史记录中统计，使用与分析相同的成本规则；
未完成的运行会被忽略。`get_analytics`（以及 `GET /api/analytics`）在
`report.budgets` 中提供 `day`/`week` 用量（`spentUsd`、`runs`、`limitUsd`、
`remainingUsd`、`ratio`、`exceeded`、`disabled`）以及总的 `exceeded` 标志。
当启用某个限额并达到时，新运行会自动暂停：`run_task`、`run_mission`、
`run_task_now` 以及 RPC/GUI、文件触发和 MCP 入口都会拒绝启动，并给出原因，
直到下一个周期。运行被阻止时会向已配置的通知渠道（webhook/Telegram/原生通知）
发送警报；相同原因的重复警报在 24 小时内会被抑制。预算默认 fail-open：
禁用的分组和零限制永远不会阻止运行，且统计始终可见。

### Prometheus

`GET /metrics` 暴露 Prometheus 文本格式（0.0.4）：`opencode_scheduler_info`、
`up`、`queue_depth`、`history_records`、`runs_total{task,status}`、
`errors_total{task}`、`tokens_total{task}`、`cost_usd_total{task}` 以及
`run_duration_seconds` 直方图（1 s … 3600 s + `+Inf`）。`runs_total` 有
独立的 `success`、`error` 和 `partial` 状态；`errors_total` 只统计
错误和超时，因此 `partial` 永远不会把它抬高。数值在抓取时从
SQLite 读取，因此不需要额外的 agent 或导出器进程。

### 结构化日志

每次运行的开始/结束以及每次 webhook 决策都会追加到
`<PLUGIN_DIR>/logs/runs.jsonl`（每行一个 JSON 对象，达到 10 MiB 轮转为
`runs.jsonl.1`）。`GET /api/logs` 返回最新在前的记录，支持 `task`、
`status`、`event`、`since`、`until`、`limit` 和 `format=jsonl`。数据库
`history` 表仍是聚合的事实来源；JSONL 用于日志
外送和调试，写入失败时从不阻塞运行。

### 传入 webhook

`POST /api/hooks/:task?token=…` 可以从 GitHub Actions、GitLab CI 或任何
外部系统启动任务。请求必须在 `X-Scheduler-Signature: sha256=<hex>` 中携带
原始正文的 HMAC-SHA256（GitHub 的 `X-Hub-Signature-256` 和裸
十六进制摘要也被接受）。令牌也可以来自 `X-Scheduler-Token`
或 `X-Gitlab-Token`。可选的 `X-Scheduler-Timestamp` 会对照
`timestampToleranceSeconds` 校验。钩子默认禁用；用空凭据启用它们时会自动生成令牌和密钥。错误：401（坏的
令牌/签名/时间戳）、403（通道已禁用或缺少凭据）、404
（未知任务）、413（正文超过 `maxBodyBytes`）。仪表板仍然只绑定
localhost，因此外部 CI 需要隧道或自托管运行器。

#### 面向发送方的重放保护指引

剩下的两种认证模式在传输层都是可重放的，因此
选择发送方式时应当考虑到这一点：

- **`timestampToleranceSeconds = 0` 的签名（legacy）。** HMAC 只覆盖
  正文，因此任何被截获的请求都可以原样重放，永远有效。
  设置非零容差并发送 `X-Scheduler-Timestamp`（unix 秒或
  毫秒）：这样签名就覆盖 `<timestamp>.<body>`，被捕获的
  请求在窗口之外便会失效。
- **仅令牌模式。** 查询参数或请求头中的 Bearer 令牌同样
  可以被重放——调度器无法区分正常的重复与重放。如果你
  无法切换到带时间戳签名的 HMAC，请改为采取缓解措施：把令牌保存在
  CI 密钥中（不要写进代码），定期轮换它，为每个任务限定一个令牌，并
  让目标任务保持幂等，使意外的重放不造成危害。
- **GitHub Actions。** GitHub 自身不会发送 `X-Scheduler-Timestamp`，因此
  仅凭 `X-Hub-Signature-256` 运行在 legacy（可重放）模式。建议
  使用用共享密钥对 `<timestamp>.<body>` 签名的工作流步骤，或依赖
  短生命周期的工作流运行和幂等任务。
- 调度器本身不执行重放缓存：唯一请求去重
  （例如事件 ID）是发送方的责任。

### OpenTelemetry

历史可以导出为 OTLP/JSON：每次运行一个 span，确定性的 32 位十六进制
`traceId` 和 16 位十六进制 `spanId`、纳秒时间戳、task/status/duration/tokens/
cost/model/error 属性以及 OK/ERROR 状态。输出可以提交到
OpenTelemetry Collector，也可以直接查看。

### 日志

每次运行都追加到 `logs/<task>.log`——前置/后置钩子、Quality Gate 输出以及
agent 的 stdout/stderr。`get_task_logs` 返回末尾（1–1000 行）。

### 试运行

`dry_run` 模拟一个任务或所有任务：执行顺序、DAG 前置条件、矩阵
扇出和预估时间。不执行任何东西，也不创建任何东西。

### 仪表板

本地 Web 仪表板展示任务、矩阵标签页、按工作区的汇总、DAG 标记、
指标、14 天分析区块（KPI、每日柱状图、按成本排名的热门任务、矩阵）、
最近运行以及 CSV/JSON 历史导出。它绑定 localhost 且没有认证
——不要对外暴露它。`GET /api/health` 报告插件版本、调度器后端、队列
深度和数据库状态，供外部监控使用。

## 管理

### 模板

把定义保存为可复用的模板，然后一键或一次工具调用即可从中创建任务。

### 导出与导入

`export_tasks` 生成带版本的 JSON 文档，包含定义，以及矩阵
配置和 `matrixParentId`。`import_tasks` 校验每条记录并逐条
报告错误，而不是让整批失败。未知工作区和无效的
矩阵组合会被明确拒绝。

### 通知

运行完成时通过三个相互独立的通道发送通知——webhook、Telegram
以及原生 OS 通知——可在设置中配置，并可用
`test_notification` 测试。

- **Webhook 投递：** 每个任务完成（成功/错误/超时）通过与
  Discord/Slack 兼容的 webhook（`{ content, text }`）。`webhook.timeoutMs`
  （默认 10 000）、`webhook.retryCount`（默认 2）和 `webhook.retryDelayMs`
  （默认 1000）控制请求；网络错误、超时、HTTP 5xx 和 429 会
  以指数退避重试（上限 30 s），其他 4xx 不重试。
- **Telegram：** Bot API `sendMessage`，带 `chat_id`、`parse_mode`（`HTML`、
  `MarkdownV2`、`Markdown` 或纯文本）、可选静默模式、论坛主题
  （`messageThreadId`）和仪表板链接（`includeDashboardLink`）。在
  GUI 中或用 `manage_settings` → `notifications.telegram` 配置。`botToken` 和 `chatId`
  也可以来自 `OPENCODE_SCHEDULER_TELEGRAM_BOT_TOKEN` 和
  `OPENCODE_SCHEDULER_TELEGRAM_CHAT_ID`，这样 `settings.json` 中就不存储任何密钥；
  令牌在每条错误消息和日志行中都被遮蔽。
- **原生 OS 通知：** Windows Toast（PowerShell/WinRT）、macOS 通知
  中心（`osascript`）和 Linux `notify-send`。没有额外依赖：不需要
  `node-notifier`。`notifications.native.sound` 在支持的地方开关声音。
- **模板：** `templates.success` 和 `templates.error` 接受占位符
  `{task}`、`{status}`、`{duration}`、`{error}`、`{emoji}`、`{cost}` 和 `{tokens}`。
  当存在 token/成本数据时，消息会加上 ` · 1500 tok · $0.0060` 后缀。
- **过滤：** `filters.include` / `filters.exclude` 是带 `*`
  通配符的任务名模式；空的 include 列表表示所有任务，exclude 优先。
- **免打扰时段：** `quietHours.enabled`，`from`/`to` 为 `HH:MM`（支持跨夜
  区间，例如 22:00 → 08:00）。在该窗口内 `success` 和
  `partial` 被抑制，而 `error` 和 `timeout` 仍会投递。
- **去重（31.2）：** `notifications.dedup.enabled` 把 `windowMinutes`
  （默认 60）内相同任务 + 状态的通知分组。启用
  `suppressDuplicates` 时，非重要的重复会被抑制；`importantStatuses`
  （默认 `error`、`timeout`）中列出的状态始终投递，并带有本地化的重复
  后缀，例如 `(repeat 3)`。计数器存放在 SQLite 的 `notification_dedup`
  表中，因此能挺过短生命周期的 `record-history` 进程，并且
  `maxCount` 对计数器封顶。
- **矩阵通知：** 在整个家族完成时——成功、`partial`（`onPartial`）
  以及所有克隆都失败（`onAllFailed`）。卡住检测器会报告运行
  超过 `matrix.stuckAfterMinutes`（默认 60，`0` 表示禁用）的克隆，每次运行报告一次。
- **摘要：** `digest.enabled` 发送每日（`frequency: "daily"`，在 `digest.time`）
  或每周（周一，之后补发）汇总：运行次数、成功率、成本、token
  和主要错误，通过每个已启用的通道发送。也可通过
  `send_digest` RPC 和 GUI 的 **Send digest now** 按钮使用（手动
  发送不会移动计划）。
- **测试按钮：** 向 `all`、`webhook`、`telegram` 或 `native`
  发送测试消息，并报告每个通道的成功/失败。一个通道的
  失败从不阻塞其他通道，也从不抛入任务运行。

### Secrets（Sprint 26）

加密的密钥存储位于 `<PLUGIN_DIR>/secrets.json`，使用 AES-256-GCM 和
32 字节密钥文件 `secrets.key`（POSIX 上权限 0600；Windows 上是一个仅授予
当前用户的 ACL，通过 `icacls` 应用）。`manage_secrets` 工具（以及 **Secrets**
GUI 面板）支持 `list`、`set` 和 `delete`。密钥名匹配
`[A-Za-z0-9_.-]`，最长 64 个字符；列表只显示名称、遮蔽预览
（`••••` + 后 4 位）和更新时间——从不显示值。

在任务工作区的 `env` 中，用 `${secret:NAME}` 引用密钥。值在
运行时被替换（缺失的密钥解析为空字符串，并给出仅含
名称的警告）。密钥引用不会被遮蔽——它们在 GUI 环境变量
编辑器中按原样显示——而字面的类密钥值（`TOKEN=`、`PASSWORD=`、…）
在日志、结构化日志、历史和审计中被遮蔽为 `***`。

#### 恢复被隔离的密钥存储

如果 `secrets.json` 解析失败，它会被隔离，而不是被删除：文件被
重命名为原文件旁边的 `secrets.json.corrupt-<timestamp>`。这是
读取操作的副作用——恢复是**设计上手动进行**的，以确保没有任何
自动重写能够破坏数据：

1. 在插件目录中找到被隔离的文件：`secrets.json.corrupt-*`
   （Windows：`%APPDATA%\opencode\agent-steward\`，macOS/Linux：
   `~/.config/opencode/agent-steward/` 或 `$XDG_CONFIG_HOME`）。
2. 检查它：损坏通常是被截断的 JSON（写入中断）或
   手工编辑。在文本编辑器中修正 JSON 语法。
3. 把修好的文件复制回 `secrets.json`（保留 `.corrupt-*` 副本作为
   备份），并用 `manage_secrets`（`action: "list"`）验证。
4. 如果文件无法修复，用 `manage_secrets`
   （`action: "set"`）重新设置密钥；用已丢失的 `secrets.key` 加密的值无法
   恢复——请重新输入它们。
5. 在更罕见的连重命名都失败的情况下，写入保持阻塞
   （`corruptedStore` 被置位），直到手动清除 `.corrupt-*` 路径——
   自己把损坏的文件移走，然后重新设置密钥。

### 审计日志（Sprint 26）

每一次变更——任务创建/更新/删除/运行、设置、模板、配置档案、
工作区、密钥、导入、历史清理——都会记录在 SQLite 的 `audit_log`
表中，包含动作、目标类型/目标、操作者（`mcp`/`gui`/`http`）、
来源、脱敏详情和远程地址。`ts` 和 `action` 上建有索引；
保留期默认为 90 天 / 10 000 条记录，并自动清理。

`get_audit_log` 工具（以及 **Audit log** GUI 面板）按
`action`、`target`、`actor`、`since`/`until` 和 `limit` 过滤读取日志。也可
通过 RPC `get_audit` 和 HTTP `GET /api/audit` 获取。详情中的
密钥值会被脱敏；`${secret:NAME}` 引用按原样保留。

### 崩溃恢复

崩溃后仍停留在 `running` 的运行会在下次插件启动时标记为
`error`，因此时间线从不说谎。孤立的矩阵克隆也会在启动时清理。

### 设置

全局默认值（超时、并发、通知、历史保留）存放在
`settings.json` 中，可从 GUI/RPC 层编辑。历史保留使
原始运行日志保持有界：`history.retentionDays`（默认 30）和 `history.maxRecords`
（默认 5000）；`0` 表示禁用相应限制。清理在插件启动时每天最多运行一次，记录
`lastCleanupAt` / `lastCleanupDeleted`，也可通过 `cleanup_history` RPC 和 GUI 的 **Clear now** 按钮使用。`metrics.json` 中的
聚合不受保留期影响。

## Agent 接口

二十九个工具：`schedule_task`、`list_tasks`、`update_task`、`delete_task`、
`run_task_now`、`pause_task`、`resume_task`、`get_history`、`get_task_logs`、`dry_run`、
`manage_workspaces`、`matrix_control`（results/cancel/cleanup/preview）、`get_metrics`、
`get_analytics`、`self_analysis`（健康评分、异常、趋势）、`manage_settings`、
`manage_local_ai`、`manage_templates`、`manage_profiles`、
`transfer_tasks`、`send_notification`、`get_dashboard_info`、`cleanup_history`、
`manage_secrets`、`get_audit_log`、
`emit_event`、`pipeline_validate`、`pipeline_apply`、`pipeline_export`。

捆绑的 skill `scheduled-job-best-practices` 教会 agent 安全的默认做法：
最小权限、Quality Gate、超时、矩阵并发、DAG 规则以及
创建 → 试运行 → 立即运行 → 检查 的循环。它由插件
自动注册，无需安装步骤。

`manage_local_ai` 工具读取、更新并测试本地分诊设置
（`action: "get" | "update" | "test"`）；见 [LOCAL-AI.md](LOCAL-AI.md)。

## 作者反馈（bug 报告）

`report_bug` 通过**只写**接收端（Cloudflare Worker，在 `DeadSno/agent-steward`
创建 GitHub Issue）把结构化报告发送给插件作者；npm 包里不含任何 token，
fine-grained PAT（仅 `issues:write`）保存在 Worker 的 secrets 中。

参数：`description`（必填）、`destination: "author" | "local" | "both"`
（默认 `author`）、`dryRun`（只展示 payload，不发网络请求）、
`includeLogs`（默认 **false**）、`includeAnalytics`、`contactEmail`、`taskName`。

默认发送的 payload（`schemaVersion: 1`）包含插件/操作系统/Node 版本、locale、
当前 profile、可选任务名、描述，以及明确允许时才附上的脱敏日志和汇总指标。
默认**不**发送日志、邮箱或原始环境变量；客户端会剔除 `sk-`/`ghp_`/`xox*`/bot
token、`manage_secrets` 中的值、home → `~`、email → `[EMAIL]`。

隐私控制：`feedback.enabled` 默认 **false**，`includeLogs` 默认 **false**；
endpoint 必须是 https（localhost 可用 http），保存时校验。先调用
`report_bug` 且 `dryRun: true` 可查看完整 payload，确认后再发送。GUI 中有
专门的「作者反馈」设置区，消息提供 ru/en/zh 三种语言。投递采用 fail-open：
接收端不可用时报告写入本地 outbox，启动时重试（最多 5 次），不阻塞任务。

## 本地助手（分诊）

一个可选的离线模型对失败和 partial 的运行进行分类（类别、严重程度、
置信度、原因）。模型从不自行抑制通知：只有
带 `action: "skip"` 的匹配规则引擎规则才能做到。它是选择加入且
失败开放的：没有模型时由规则引擎或直接投递接管，
通知永远不会因模型不可用而被阻塞。
它从不改变运行状态、重试、Quality Gate、DAG 依赖或历史。

- `mode`：`off`（默认）、`rules`、`llm` 或 `auto`（先模型，后规则）。
- `fallback`：模型失败或不确定时用 `rules`（默认）或 `notify`。
  旧值 `skip` 作为 `notify` 的别名被接受。
- `confidenceThreshold`：模型的最低置信度（0..1）。
- 省略 `rules` 表示使用内置规则；`rules: []` 禁用它们；自定义
  数组会替换内置规则集。
- 内置规则覆盖错误、状态、成本和任务名
  （deploy/release/backup/migration）；全部仅用于通知。示例见
  [LOCAL-AI.md](LOCAL-AI.md)。
- GUI 显示彩色的连接状态（未检查 / 检查中 /
  已连接 / 无连接），并在模式、URL 或模型变化时重置它。
- 在 `llm`/`auto` 下，分诊是异步的：通知立即
  投递，一个分离的工作者把结论写入审计。只有
  `rules` 模式在投递前分诊，因为只有规则能够抑制。
- `notifications.embedding` 在精确去重之上增加语义去重：
  消息被转换为归一化的词袋向量存入 SQLite，
  在窗口内按余弦相似度比较，超过
  `threshold`（默认 0.85）时被抑制。重要状态
  永远不会被抑制。不需要新依赖，也不需要外部
  嵌入模型。CJK 文本（中文、日文、韩文）按重叠的
  二元组切分，因此没有空格的消息也会得到非零向量
  并参与去重。
- `notifications.summary` 为 Telegram 和
  toast 最多渲染三行短文本。模型返回严格的 JSON
  `{"lines": [...]}`；任何失败都会回退到确定性截断（状态、
  错误、运行时长/token/成本），投递最多等待
  `summary.timeoutMs`（默认 8 s）。
- 影子模式把决策记录到持久审计日志
  （`get_audit_log`，动作 `triage.decision`）而不抑制通知，
  因此可以在强制执行之前安全地评估分诊效果，且报告
  能在重启后保留。

设置、按内存划分的模型层级、`npm run bench:local` 基准测试、
影子工作流和故障排查（包括 `OLLAMA_CONTEXT_LENGTH`）都记录在
[LOCAL-AI.md](LOCAL-AI.md)。

## 平台支持

| 能力 | Windows | Linux | macOS |
| --- | --- | --- | --- |
| Cron 调度 | Task Scheduler | crontab | launchd |
| 回退 | — | — | crontab |
| 超时与锁 | PowerShell 包装器 | bash 包装器 | bash 包装器 |
| 文件触发器 | chokidar | chokidar | chokidar |
| 历史、指标、仪表板 | 是 | 是 | 是 |
| Agent 工具与 skill | 是 | 是 | 是 |
| 无已登录用户运行 | 选择加入（`runWhenLoggedOff`） | 总是（crontab） | 否（按用户代理） |

## 限制与非目标

- **没有 `triggerType: "once"` 就没有一次性调度。** 一次性运行通过
  `runAt`/`delaySeconds` 实现；要立即运行请使用 `run_task_now`。
- **没有超出内置 `session` 模式的会话连续性。** `new`、`reuse`
  和 `last` 覆盖常见场景；不支持按消息分叉/分支会话。
- **没有沙箱。** 钩子、Quality Gate 和 prompt 都以你的用户权限运行。
- **仪表板没有认证。** 设计上仅限 localhost。
- **密钥在静态存储时使用 AES-256-GCM 加密**，保存在 `<PLUGIN_DIR>/secrets.json`
  （见 Secrets 一节）。密钥存放在 `secrets.key` 中；丢失后已存储的值无法恢复。
  对于更高敏感度的密钥，建议使用环境变量或外部密钥管理器。
- **`allowedTools` / `deniedTools` 限制的是 agent 进程，而不是整个作业。**
  钩子、Quality Gate 和包装器脚本仍以你的用户权限运行，而且项目级
  或系统级 `opencode.jsonc` 可以削弱任务范围的拒绝规则。见
  ARCHITECTURE.md 中的权限强制限制。
- **矩阵克隆是独立的任务。** 它们出现在任务列表中（归组在父任务
  下），并像任何其他运行一样消耗全局并发槽位。
