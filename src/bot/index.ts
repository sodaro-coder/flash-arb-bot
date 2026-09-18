import { loadConfig } from "./config.js";
import { ArbitrageEngine, type EngineEvent } from "./engine.js";

function print(event: EngineEvent): void {
  const safeEvent = JSON.stringify(event, (_, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  process.stdout.write(`${safeEvent}\n`);
}

const config = await loadConfig();
const engine = new ArbitrageEngine(config, print);

if (process.argv.includes("--once")) {
  await engine.runOnce();
} else {
  process.on("SIGINT", () => {
    engine.stop();
    process.exitCode = 0;
  });
  process.on("SIGTERM", () => {
    engine.stop();
    process.exitCode = 0;
  });
  await engine.start();
}
