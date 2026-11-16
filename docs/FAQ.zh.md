# 常见问题

常见问题与恢复场景。

Translations: [English](FAQ.md) · [Русский](FAQ.ru.md)

## 目录

- [`.corrupt-*` 隔离后如何恢复密钥](#隔离后如何恢复密钥)
- [Webhook 触发器：请求会被重放吗？](#webhook-触发器请求会被重放吗)

## 隔离后如何恢复密钥

当 `secrets.json` 无法解析（写入被中断或手工编辑）时触发隔离。文件**不会被删除**，
而是重命名为同目录下的 `secrets.json.corrupt-<时间戳>`。这是读取操作的副作用；
恢复**按设计是手工的**，以免任何自动重写破坏数据。

恢复步骤：

1. 在插件目录中找到该文件：`%APPDATA%\opencode\windows-scheduler\`（Windows）
   或 `~/.config/opencode/windows-scheduler/`（macOS/Linux，或 `$XDG_CONFIG_HOME`）。
2. 用编辑器打开：通常是截断的 JSON，修正语法。
3. 把修好的文件复制回 `secrets.json`（保留 `.corrupt-*` 副本作为备份），
   用 `manage_secrets`（`action: "list"`）验证。
4. 如果文件无法修复，重新设置密钥（`manage_secrets`，`action: "set"`）。
   用丢失的 `secrets.key` 加密的值无法恢复——请重新输入。
5. 罕见情况：重命名失败且写入被阻止（"Writing new secrets is blocked"）。
   手工移走损坏文件，然后重新设置密钥。

## Webhook 触发器：请求会被重放吗？

会——在两种剩余认证模式下请求都可被重放，因此防重放是发送方的责任：

- **带签名但未设置 `timestampToleranceSeconds`（= 0，旧模式）。** HMAC 只覆盖请求体，
  被截获的请求可以永远重放。设置非零容忍窗口并发送 `X-Scheduler-Timestamp`：
  签名随后覆盖 `<timestamp>.<body>`，窗口之外的请求会被拒绝。
- **仅 Token 模式。** Token 同样可被重放——调度器无法区分重复请求和攻击。
  如果无法切换到签名：把 Token 放在 CI secrets 中，定期轮换，每个任务单独签发，
  并让任务幂等。
- **GitHub Actions** 自己不发送 `X-Scheduler-Timestamp`，因此
  `X-Hub-Signature-256` 以旧模式运行。可在单独的 workflow 步骤中用共享密钥
  对 `<timestamp>.<body>` 签名。
- 调度器不保留重放缓存——对唯一请求去重是发送方的责任。
