# 「节省 $」计数器

仪表盘和 `get_analytics` 会显示 **「节省」** KPI。它是**估算**，不是账务事实：
金额会标注为估算并链接到本页。

Translations: [English](SAVINGS.md) · [Русский](SAVINGS.ru.md)

## 方法

反事实估算基于运行历史（SQLite 中的 `history`）。

1. 取分析窗口内的记录，排除未完成的运行（`status = "running"`）。
2. 当一次运行**有 token**（`tokens > 0`）且**没有记录成本**（`costUsd` 为空或 `0`）时，
   它进入估算。通常是本地模型（Ollama）或已付费订阅：消耗了 token 但未扣费。
3. 对每次这样的运行计算假设的云端成本：

   ```
   saved = tokens / 1000 × referenceCostPer1kTokensUsd
   ```

4. 在窗口内对所有运行求和，并按任务拆分（按节省额取前 10）。

默认参考价格为 **每 1k token $0.01**（中端云厂商输入/输出混合价），即
`src/core/savings.ts` 中的常量 `CLOUD_REFERENCE_COST_PER_1K_TOKENS_USD`。
有记录成本的运行不计入节省：已经扣过费，没什么可对比的。

## 估算未考虑的因素

- 提示词缓存、折扣和批量定价；
- 输入与输出 token 的价格差异；
- 没有 token 的运行（例如纯 shell 运行）：可能根本没有节省；
- 成本因错误而未记录（而非因为为零）的运行——这类记录会虚增估算。

因此该计数器回答的是「按参考价格在云端要花多少钱」，而不是「实际退回了多少钱」。

## What-If：模型与价格

仪表盘的「如果所有运行都使用模型 X」区块不再依赖硬编码列表。列表和价格都来自 OpenCode 本身：

1. **可用模型** —— `opencode models`，即本机实际配置的模型（提供商、密钥、本地 Ollama 模型）。先列出运行历史中出现过的模型，之后每种价格只列一个（最便宜、中间、最贵），总共不超过五行。
2. **价格** —— OpenCode 缓存在 `<cache>/opencode/models.json` 的 models.dev 目录（`cost.input` / `cost.output`，USD / 1M token）。历史记录不区分输入与输出 token，因此取两者价格的平均值。

价格顺序：`OPENCODE_SCHEDULER_MODEL_PRICES`（JSON）→ OpenCode 目录 → 内置表 → 每 1M token 3 美元。本地提供商（Ollama、LM Studio）和 `*-free` 模型按零计算。

| 变量 | 含义 |
| --- | --- |
| `OPENCODE_SCHEDULER_WHAT_IF_MODELS` | 显式 JSON 列表，替换自动选择 |
| `OPENCODE_SCHEDULER_MODEL_PRICES` | 显式价格，例如 `{"openai/gpt-4o": 2.5}` |
| `OPENCODE_SCHEDULER_MODELS_CACHE` | 指向另一个 `models.json` |
| `OPENCODE_SCHEDULER_MODEL_SOURCE=static` | 不访问 OpenCode，只用内置值 |

如果 OpenCode 不可用，该区块会回退到内置列表和价格，仪表盘继续正常工作。

## API

`get_analytics` 返回 `report.savings`：

| 字段 | 值 |
| --- | --- |
| `kind` | 始终为 `estimate` |
| `savedUsd` | 估算节省额，USD |
| `runs` | 反事实中的运行数 |
| `tokens` | 这些运行的 token 数 |
| `actualCostUsd` | 这些运行记录的成本（通常为 0） |
| `totalCostUsd` | 窗口内所有运行记录的成本 |
| `referenceCostPer1kTokensUsd` | 参考价格 |
| `methodologyUrl` | 指向本页的链接 |
| `byTask` | 拆分 `{ taskName, runs, tokens, savedUsd }` |

该方法在固定数据上验证：`test-savings.mjs`，14 项检查。
