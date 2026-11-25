/**
 * EX-1.1: мост runner'а для запечённой обёртки.
 *
 * Обёртка вызывает `node <runner-run.js> <base64-конфиг> <команда> ...`,
 * где обёртка добавляет `--model`, `--session` и `-- <prompt>` после токена.
 * Мост разворачивает конфиг, присоединяет аргументы харнесса и исполняет
 * финальную команду через выбранный транспорт (local/docker/ssh) с fail-open.
 */
import {
  decodeRunnerAgentDefaults,
  resolveRunner,
  spawnInvoke,
  type RunnerLaunch,
} from "./runner.js";

const [token, ...rest] = process.argv.slice(2);

if (!token) {
  console.error("[runner-run] отсутствует токен конфигурации runner'а");
  process.exit(2);
}

let defaults;
try {
  defaults = decodeRunnerAgentDefaults(token);
} catch (error) {
  console.error(
    `[runner-run] некорректная конфигурация: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

const launch: RunnerLaunch = {
  command: defaults.harness.commandPath,
  args: [...defaults.harness.args, ...rest],
};

const resolved = resolveRunner(defaults.runner);
try {
  const result = await resolved.runner.execute(launch, spawnInvoke);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(
    `[runner-run] ошибка runner'а (${resolved.runner.name}): ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
