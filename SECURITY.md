# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.0.x | ✅ |
| < 0.0 | ❌ |

## Threat model — read this first

`agent-steward` is a **local automation tool**. By design it:

- registers jobs with the operating system scheduler;
- generates wrapper scripts that execute `opencode run` with a prompt;
- runs user-provided `beforeScript`, `afterScript` and Quality Gate commands through the system shell;
- stores job definitions, history and logs on the local machine.

Therefore:

1. **Job definitions are code.** Anyone who can create or edit a job can execute arbitrary commands under your user account. Protect the config directory and review imported job files (`.json`) before importing.
2. **The web dashboard is local.** Do not expose its port to untrusted networks; it has no authentication layer.
3. **Secrets** (`${secret:NAME}`) are scoped to the fields where they are actually used and masked in logs/outputs. Secret masking is enforced; prefer environment variables managed outside the plugin for additional isolation.
4. **Tool allow/deny lists are enforced** by the runtime wrappers, not just metadata. They do not replace OS-level isolation. Background jobs default to the `hybrid` permission policy: `shell` and `question` are denied unless the job explicitly lists them in `allowedTools` (or sets the transitional `legacyShell: true`). See [`README.md` → Permissions](README.md#permissions).
5. **Dashboard mutations** (run, delete, cancel-matrix, matrix-cleanup) require a trusted source. The source check is **Origin-first**: a request with an `Origin` header is trusted only when that origin is loopback (`127.0.0.1`, `localhost`, `::1`); a request without `Origin` is trusted only when its `Host` is loopback. The custom `X-Scheduler-Client` header is additional confirmation and **does not bypass** this check — an external or `null` Origin is rejected even when the header is present. The port is bound to loopback only; do not expose it to untrusted networks.
6. **Encryption keys on Windows.** `secrets.key` gets mode `0600` on POSIX. Windows ignores POSIX modes, so the plugin applies a restrictive ACL with `icacls` (`/inheritance:r` and a single full-control grant for the current user). This is best-effort: if `icacls` fails, a warning is logged and the key remains protected only by the default profile ACL. The same protection is applied to existing keys on first load after an upgrade.
7. **Background jobs run with `--auto`.** Permission rules are generated per job and passed through `OPENCODE_CONFIG_CONTENT`; they are not a sandbox. Treat every job definition as code and review imported jobs.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

- Use GitHub Security Advisories: <https://github.com/DeadSno/agent-steward/security/advisories/new>
- Include: affected version, OS, reproduction steps, impact and a suggested fix if you have one.

You can expect an acknowledgement within 72 hours and a coordinated disclosure timeline. Reporters will be credited in the release notes unless they prefer otherwise.

## Scope

In scope: command injection through job fields, path traversal in export/import, unsafe wrapper generation, credential leakage in logs, privilege issues in the OS scheduler integration, dashboard exposure.

Out of scope: issues that require an already-compromised local account, and the intentional ability to run arbitrary shell commands through job definitions.
