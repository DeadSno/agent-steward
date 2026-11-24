// Деталь 3.19 / S-5: верифицированный чат (ответ только с гейтом/источником).
//
// Проверяем:
//  - формат, версию, методику и публичный экспорт из agent-steward/core;
//  - выдачу ответа по объективному гейту, ссылке на источник и gate-passed рецепту;
//  - отказ без доказательств, по самооценке, битым полям и неизвестному рецепту;
//  - порог minEvidence, валидацию, детерминизм и отсутствие мутаций;
//  - CLI `chat verify <file.json> [--json]` и exit-коды.
//
// Запуск: node test-verified-chat.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname);
let passed = 0;
let failed = 0;
const assert = (message, cond) => {
  if (cond) {
    passed += 1;
    console.log(`OK   ${message}`);
  } else {
    failed += 1;
    console.error(`FAIL ${message}`);
  }
};

const vc = await import("./dist/core/verified-chat.js");
const {
  verifyChatAnswer,
  VERIFIED_CHAT_FORMAT,
  VERIFIED_CHAT_METHODOLOGY_URL,
  VERIFIED_CHAT_VERSION,
} = vc;
const core = await import("./dist/core-entry.js");

assert("формат и версия решения зафиксированы", VERIFIED_CHAT_FORMAT === "agent-steward.verified-chat" && VERIFIED_CHAT_VERSION === "1.0");
assert("ссылка на методику рядом с решением", VERIFIED_CHAT_METHODOLOGY_URL.includes("docs/VERIFIED-CHAT.md#methodology"));
assert("публичный экспорт из agent-steward/core", typeof core.verifyChatAnswer === "function" && core.VERIFIED_CHAT_FORMAT === VERIFIED_CHAT_FORMAT);

const gate = {
  kind: "gate",
  source: "test-open-spec.mjs",
  command: "node test-open-spec.mjs",
  passed: true,
  objective: true,
  recordedAt: "2026-11-24T10:00:00.000Z",
  commit: "9db0d75",
};
const source = {
  kind: "source",
  source: "docs/OPEN-SPEC.md",
  locator: "#methodology",
  quote: "Открытый spec описывает DAG, гейты и бюджеты.",
  checkedAt: "2026-11-24T10:05:00.000Z",
};
const answer = "Ответ подтверждён объективным гейтом.";

const byGate = verifyChatAnswer({ answer, evidence: [gate] });
assert("kind/version/format/methodologyUrl публикуются", byGate.kind === "verified-chat" && byGate.version === VERIFIED_CHAT_VERSION && byGate.format === VERIFIED_CHAT_FORMAT && byGate.methodologyUrl === VERIFIED_CHAT_METHODOLOGY_URL);
assert("гейт открывает ответ", byGate.delivered === true && byGate.answer === answer && byGate.refusal === null);
assert("принят ровно один гейт", byGate.accepted.gates === 1 && byGate.accepted.sources === 0 && byGate.accepted.recipes === 0 && byGate.evidenceCount === 1);
assert("при успехе reasons пусты", byGate.reasons.length === 0);

const bySource = verifyChatAnswer({ answer, evidence: [source] });
assert("источник с цитатой открывает ответ", bySource.delivered === true && bySource.accepted.sources === 1 && bySource.answer === answer);

const byRecipe = verifyChatAnswer({ answer, evidence: [], recipeId: "open-spec" });
assert("gate-passed рецепт из S-4 открывает ответ", byRecipe.delivered === true && byRecipe.accepted.recipes === 1 && byRecipe.accepted.gates === 0);

const combinedInput = { answer, evidence: [gate, source], recipeId: "capability-router" };
const combined = verifyChatAnswer(combinedInput);
assert("гейт + источник + рецепт считаются раздельно", combined.delivered === true && combined.accepted.gates === 1 && combined.accepted.sources === 1 && combined.accepted.recipes === 1 && combined.evidenceCount === 2);
assert("вывод детерминирован", JSON.stringify(verifyChatAnswer(combinedInput)) === JSON.stringify(combined));
assert("вход не мутируется", JSON.stringify(combinedInput.evidence[0]) === JSON.stringify(gate) && JSON.stringify(combinedInput.evidence[1]) === JSON.stringify(source));

const refusedCases = [
  ["нет доказательств", { answer, evidence: [] }, /Недостаточно проверенных доказательств/],
  ["самооценка модели", { answer, evidence: [{ ...gate, objective: false }] }, /objective\/passed/],
  ["гейт не пройден", { answer, evidence: [{ ...gate, passed: false }] }, /objective\/passed/],
  ["битая ISO-дата гейта", { answer, evidence: [{ ...gate, recordedAt: "вчера" }] }, /objective\/passed/],
  ["нет команды гейта", { answer, evidence: [{ ...gate, command: "  " }] }, /objective\/passed/],
  ["неизвестный вид доказательства", { answer, evidence: [{ kind: "feeling", note: "кажется" }] }, /неизвестный вид/],
  ["неизвестный рецепт", { answer, evidence: [gate], recipeId: "nope" }, /не найден/],
  ["пустой recipeId", { answer, evidence: [gate], recipeId: "  " }, /пустой recipeId/],
  ["короткий/non-hex коммит", { answer, evidence: [{ ...gate, commit: "zz" }] }, /objective\/passed/],
  ["источник без цитаты", { answer, evidence: [{ ...source, quote: "" }] }, /источник должен содержать/],
  ["источник без якоря", { answer, evidence: [{ ...source, locator: "" }] }, /источник должен содержать/],
];
for (const [label, input, pattern] of refusedCases) {
  const decision = verifyChatAnswer(input);
  assert(`отказ: ${label}`, decision.delivered === false && decision.answer === null && decision.refusal !== null && pattern.test(decision.refusal));
}
const secretAnswer = "СЕКРЕТНЫЙ ОТВЕТ 42";
const leaked = verifyChatAnswer({ answer: secretAnswer, evidence: [] });
assert("при отказе текст ответа не утекает в результат", !JSON.stringify(leaked).includes(secretAnswer));

const one = verifyChatAnswer({ answer, evidence: [gate] }, { minEvidence: 2 });
assert("minEvidence=2 отказывает при одном доказательстве", one.delivered === false && /Недостаточно/.test(one.refusal ?? ""));
const two = verifyChatAnswer({ answer, evidence: [gate, source] }, { minEvidence: 2 });
assert("minEvidence=2 выдаёт ответ при двух доказательствах", two.delivered === true && two.answer === answer);

const throws = [
  ["null вместо ввода", () => verifyChatAnswer(null)],
  ["массив вместо ввода", () => verifyChatAnswer([])],
  ["пустой answer", () => verifyChatAnswer({ answer: "  ", evidence: [] })],
  ["evidence объектом", () => verifyChatAnswer({ answer, evidence: {} })],
  ["minEvidence=0", () => verifyChatAnswer({ answer, evidence: [gate] }, { minEvidence: 0 })],
  ["minEvidence=1.5", () => verifyChatAnswer({ answer, evidence: [gate] }, { minEvidence: 1.5 })],
];
for (const [label, fn] of throws) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(`валидация: ${label}`, threw);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steward-chat-"));
try {
  const okPath = path.join(tempRoot, "ok.json");
  fs.writeFileSync(okPath, JSON.stringify({ answer, evidence: [gate] }), "utf8");
  const okJson = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "chat", "verify", okPath, "--json"], { encoding: "utf8", cwd: root });
  assert("CLI chat verify --json exit 0", okJson.status === 0, okJson.stderr);
  const fromCli = JSON.parse(okJson.stdout);
  assert("CLI вернул то же решение", fromCli.delivered === true && fromCli.answer === answer && fromCli.accepted.gates === 1);
  const okHuman = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "chat", "verify", okPath], { encoding: "utf8", cwd: root });
  assert("CLI печатает ответ и сводку", okHuman.status === 0 && okHuman.stdout.includes("OK ответ выдан") && okHuman.stdout.includes(answer));

  const noPath = path.join(tempRoot, "refused.json");
  fs.writeFileSync(noPath, JSON.stringify({ answer, evidence: [] }), "utf8");
  const noJson = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "chat", "verify", noPath, "--json"], { encoding: "utf8", cwd: root });
  assert("CLI отказ --json exit 1", noJson.status === 1 && JSON.parse(noJson.stdout).delivered === false);
  const noHuman = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "chat", "verify", noPath], { encoding: "utf8", cwd: root });
  assert("CLI отказ печатает причину и не печатает ответ", noHuman.status === 1 && noHuman.stderr.includes("ОТКАЗ") && !noHuman.stdout.includes(answer));

  const badPath = path.join(tempRoot, "bad.json");
  fs.writeFileSync(badPath, "[]", "utf8");
  const bad = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "chat", "verify", badPath], { encoding: "utf8", cwd: root });
  assert("не объект JSON даёт exit 1", bad.status === 1);
  fs.writeFileSync(badPath, "{nope", "utf8");
  const badSyntax = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "chat", "verify", badPath], { encoding: "utf8", cwd: root });
  assert("битый JSON даёт exit 1", badSyntax.status === 1);
  const missing = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "chat", "verify", path.join(tempRoot, "missing.json")], { encoding: "utf8", cwd: root });
  assert("несуществующий файл даёт exit 1", missing.status === 1);

  const unknown = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "chat", "guess", okPath], { encoding: "utf8", cwd: root });
  assert("неизвестная подкоманда chat даёт exit 2", unknown.status === 2);
  const noCommand = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "chat"], { encoding: "utf8", cwd: root });
  assert("chat без подкоманды даёт exit 2", noCommand.status === 2);
  const help = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "chat", "--help"], { encoding: "utf8", cwd: root });
  assert("chat --help печатает usage", help.status === 0 && help.stdout.includes("chat verify"));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failed} проверок верифицированного чата пройдены.`);
process.exit(failed > 0 ? 1 : 0);
