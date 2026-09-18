import { createReadStream } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../bot/config.js";
import { ArbitrageEngine, type EngineEvent } from "../bot/engine.js";

interface DashboardState {
  mode: "demo" | "scan-only" | "live" | "not-configured";
  running: boolean;
  pollIntervalMs: number;
  routeWorkers: number;
  chainId?: number;
  keeperAddress?: string;
  wallet: { balance: string; symbol: string };
  lastCycle?: { at: string; candidates: number };
  candidates: Array<Record<string, unknown>>;
  trades: Array<Record<string, unknown>>;
  activity: Array<{ type: string; message: string; at: string }>;
}

const publicDirectory = join(dirname(fileURLToPath(import.meta.url)), "public");
const listeners = new Set<ServerResponse>();
const demoMode = process.env.DEMO_MODE === "true";
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
const configuredHostHeader = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
const configuredOrigin = `http://${configuredHostHeader}`;
let engine: ArbitrageEngine | undefined;
let demoTimer: NodeJS.Timeout | undefined;
let demoStep = 0;

const state: DashboardState = {
  mode: demoMode ? "demo" : "not-configured",
  running: false,
  pollIntervalMs: 2_500,
  routeWorkers: demoMode ? 6 : 0,
  wallet: { balance: demoMode ? "0.0031" : "—", symbol: "ETH" },
  candidates: [],
  trades: [],
  activity: [],
};

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function broadcast(): void {
  const payload = `data: ${safeJson(state)}\n\n`;
  for (const listener of listeners) {
    if (listener.destroyed || listener.writableEnded || !listener.write(payload)) {
      listeners.delete(listener);
      listener.destroy();
    }
  }
}

function validControlRequest(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  return (
    request.headers["x-flash-arb-control"] === "local-ui" &&
    request.headers.host === configuredHostHeader &&
    (origin === undefined || origin === configuredOrigin)
  );
}

function activity(type: string, message: string): void {
  state.activity.unshift({ type, message, at: new Date().toISOString() });
  state.activity = state.activity.slice(0, 30);
}

function onEngineEvent(event: EngineEvent): void {
  switch (event.type) {
    case "wallet":
      state.wallet = { balance: event.balance, symbol: event.symbol };
      break;
    case "cycle":
      state.lastCycle = { at: event.at, candidates: event.candidates };
      state.candidates = [];
      break;
    case "candidate":
      state.candidates.unshift({
        route: event.candidate.route,
        borrowAmount: event.candidate.borrowAmount,
        netProfit: event.candidate.expectedNetProfit,
        gasCost: event.candidate.estimatedGasCost,
        simulated: event.candidate.simulated,
        at: new Date().toISOString(),
      });
      state.candidates = state.candidates.slice(0, 20);
      activity("candidate", `Simulation passed: ${event.candidate.route}`);
      break;
    case "trade":
      state.trades.unshift({
        route: event.candidate.route,
        netProfit: event.candidate.expectedNetProfit,
        hash: event.hash,
        blockNumber: event.blockNumber,
        at: new Date().toISOString(),
      });
      state.trades = state.trades.slice(0, 20);
      activity("trade", `Confirmed trade ${event.hash.slice(0, 12)}…`);
      break;
    case "skip":
      activity("skip", `${event.route}: ${event.reason}`);
      break;
    case "error":
      activity("error", event.message);
      break;
  }
  broadcast();
}

function demoCycle(): void {
  demoStep += 1;
  const profitable = demoStep % 4 === 0;
  state.lastCycle = {
    at: new Date().toISOString(),
    candidates: profitable ? 1 : 0,
  };
  state.candidates = [];
  const drift = ((demoStep % 7) - 3) * 0.000001;
  state.wallet.balance = (0.0031 + drift).toFixed(6);
  if (profitable) {
    state.candidates.unshift({
      route: demoStep % 8 === 0 ? "WETH/USDC · DEX B → A" : "WETH/USDC · DEX A → B",
      borrowAmount: demoStep % 8 === 0 ? "0.25 WETH" : "0.1 WETH",
      netProfit: `${(0.000028 + drift / 10).toFixed(7)} WETH`,
      gasCost: "0.000006 ETH",
      simulated: true,
      synthetic: true,
      at: new Date().toISOString(),
    });
    state.candidates = state.candidates.slice(0, 20);
    activity("candidate", "Synthetic demo opportunity passed simulation");
  } else {
    activity("skip", "Synthetic quotes stayed below the net-profit floor");
  }
  broadcast();
}

async function start(): Promise<void> {
  if (state.running) return;
  if (!demoMode && !engine) {
    activity("error", "Scanner cannot start until configuration is valid");
    broadcast();
    return;
  }
  state.running = true;
  activity("system", "Scanner started");
  broadcast();
  if (demoMode) {
    demoCycle();
    demoTimer = setInterval(demoCycle, state.pollIntervalMs);
  } else if (engine) {
    await engine.start();
  }
}

function stop(): void {
  state.running = false;
  if (demoTimer) clearInterval(demoTimer);
  demoTimer = undefined;
  engine?.stop();
  activity("system", "Scanner stopped");
  broadcast();
}

if (!demoMode) {
  try {
    const config = await loadConfig();
    if (config.liveTrading && !loopbackHosts.has(host)) {
      throw new Error(
        "live trading dashboard must bind to a loopback HOST to protect start/stop controls",
      );
    }
    state.mode = config.liveTrading ? "live" : "scan-only";
    state.pollIntervalMs = config.pollIntervalMs;
    state.routeWorkers = config.routes.reduce(
      (count, route) => count + (route.bidirectional ? 2 : 1),
      0,
    );
    state.chainId = config.chain.id;
    state.keeperAddress = config.keeperAddress;
    state.wallet.symbol = config.chain.nativeCurrency.symbol;
    engine = new ArbitrageEngine(config, onEngineEvent);
  } catch (error) {
    activity(
      "error",
      `Configuration needed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const assets = new Map<string, readonly [string, string]>([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/api/state") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(safeJson(state));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/events") {
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    response.write(`data: ${safeJson(state)}\n\n`);
    listeners.add(response);
    request.on("close", () => listeners.delete(response));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/start") {
    if (!validControlRequest(request)) {
      response.writeHead(403).end();
      return;
    }
    await start();
    response.writeHead(204).end();
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/stop") {
    if (!validControlRequest(request)) {
      response.writeHead(403).end();
      return;
    }
    stop();
    response.writeHead(204).end();
    return;
  }
  const asset = assets.get(url.pathname);
  if (request.method === "GET" && asset) {
    const [file, contentType] = asset;
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'",
      "content-type": contentType,
      "x-content-type-options": "nosniff",
    });
    const stream = createReadStream(join(publicDirectory, file));
    stream.on("error", () => response.destroy());
    stream.pipe(response);
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

server.listen(port, host, () => {
  process.stdout.write(`Flash Arb Console listening on http://${host}:${port}\n`);
  if (process.env.AUTO_START === "true" && state.mode !== "live") void start();
});

function shutdown(): void {
  stop();
  for (const listener of listeners) listener.end();
  listeners.clear();
  server.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
