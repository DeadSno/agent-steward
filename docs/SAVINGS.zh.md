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
