# FAQ

Frequently asked questions and recovery scenarios. The English version of the
secrets section is also in [FEATURES.md](FEATURES.md#recovering-a-quarantined-secrets-store).

Translations: [Русский](FAQ.ru.md) · [中文](FAQ.zh.md)

## Contents

- [Recovering secrets after a `.corrupt-*` quarantine](#recovering-secrets-after-a-corrupt--quarantine)
- [Webhook triggers: can a request be replayed?](#webhook-triggers-can-a-request-be-replayed)

## Recovering secrets after a `.corrupt-*` quarantine

Quarantine triggers when `secrets.json` cannot be parsed (an interrupted write or
manual editing). The file is **not deleted** — it is renamed to
`secrets.json.corrupt-<timestamp>` next to the original. This is a side effect of a
read operation; recovery is **manual by design** so that no automatic rewrite can
destroy data.

Recovery steps:

1. Find the file in the plugin directory: `%APPDATA%\opencode\agent-steward\`
   (Windows) or `~/.config/opencode/agent-steward/` (macOS/Linux, or
   `$XDG_CONFIG_HOME`).
2. Open it in an editor: it is usually truncated JSON. Fix the syntax.
3. Copy the fixed file back as `secrets.json` (keep the `.corrupt-*` copy as a
   backup) and verify with `manage_secrets` (`action: "list"`).
4. If the file cannot be repaired, re-set the secrets (`manage_secrets`,
   `action: "set"`). Values encrypted with a lost `secrets.key` cannot be recovered
   — re-enter them.
5. Rare case: the rename failed and writes stay blocked ("Writing new secrets is
   blocked"). Move the broken file away manually, then re-set the secrets.

## Webhook triggers: can a request be replayed?

Yes — in both remaining authentication modes requests are replayable, so replay
protection is the sender's responsibility:

- **Signature without `timestampToleranceSeconds` (= 0, legacy).** The HMAC covers
  only the body, so an intercepted request can be replayed forever. Set a non-zero
  tolerance and send `X-Scheduler-Timestamp`: the signature then covers
  `<timestamp>.<body>` and a request outside the window is rejected.
- **Token-only mode.** A token is also replayable — the scheduler cannot tell a
  repeat from an attack. If you cannot switch to signatures: keep the token in CI
  secrets, rotate it regularly, issue one token per task, and make the task
  idempotent.
- **GitHub Actions** does not send `X-Scheduler-Timestamp` itself, so
  `X-Hub-Signature-256` runs in legacy mode. Sign `<timestamp>.<body>` in a separate
  workflow step with the shared secret.
- The scheduler keeps no replay cache — deduplicating unique requests is the
  sender's responsibility.
