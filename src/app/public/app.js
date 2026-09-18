const elements = {
  mode: document.querySelector("#mode"),
  toggle: document.querySelector("#toggle"),
  connect: document.querySelector("#connect"),
  warning: document.querySelector("#demo-warning"),
  wallet: document.querySelector("#wallet"),
  workers: document.querySelector("#workers"),
  interval: document.querySelector("#interval"),
  lastScan: document.querySelector("#last-scan"),
  lastResult: document.querySelector("#last-result"),
  route: document.querySelector("#route"),
  simulated: document.querySelector("#simulated"),
  profit: document.querySelector("#profit"),
  borrow: document.querySelector("#borrow"),
  gas: document.querySelector("#gas"),
  activity: document.querySelector("#activity"),
  pulse: document.querySelector("#pulse"),
};

let currentState;

function age(iso) {
  if (!iso) return "waiting";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  return seconds < 2 ? "just now" : `${seconds}s ago`;
}

function render(state) {
  currentState = state;
  elements.mode.textContent = state.mode.replace("-", " ");
  elements.mode.classList.toggle("live", state.mode === "live");
  elements.warning.classList.toggle("hidden", state.mode !== "demo");
  elements.toggle.textContent = state.running ? "Stop scanner" : "Start scanner";
  elements.wallet.textContent = `${state.wallet.balance} ${state.wallet.symbol}`;
  elements.workers.textContent = state.routeWorkers;
  elements.interval.textContent = `${(state.pollIntervalMs / 1000).toFixed(1)}s`;
  elements.lastScan.textContent = age(state.lastCycle?.at);
  elements.lastResult.textContent = state.lastCycle
    ? `${state.lastCycle.candidates} executable candidate${state.lastCycle.candidates === 1 ? "" : "s"}`
    : "no quote yet";
  elements.pulse.classList.toggle("active", state.running);

  const candidate = state.candidates[0];
  if (candidate) {
    elements.route.textContent = candidate.route;
    elements.profit.textContent = candidate.netProfit;
    elements.borrow.textContent = candidate.borrowAmount;
    elements.gas.textContent = candidate.gasCost;
    elements.simulated.textContent = candidate.synthetic ? "SYNTHETIC + SIM" : "SIM PASSED";
  } else {
    elements.route.textContent = "Scanning markets…";
    elements.profit.textContent = "—";
    elements.borrow.textContent = "—";
    elements.gas.textContent = "—";
    elements.simulated.textContent = "SIM REQUIRED";
  }

  elements.activity.replaceChildren(
    ...state.activity.slice(0, 10).map((entry) => {
      const item = document.createElement("li");
      item.className = entry.type;
      item.append(document.createTextNode(entry.message));
      const time = document.createElement("time");
      time.dateTime = entry.at;
      time.textContent = new Date(entry.at).toLocaleTimeString();
      item.append(time);
      return item;
    }),
  );
}

elements.toggle.addEventListener("click", async () => {
  const action = currentState?.running ? "stop" : "start";
  elements.toggle.disabled = true;
  try {
    const response = await fetch(`/api/${action}`, {
      method: "POST",
      headers: { "x-flash-arb-control": "local-ui" },
    });
    if (!response.ok) throw new Error(`control request failed: ${response.status}`);
  } catch {
    elements.toggle.textContent = "Control failed — retry";
  } finally {
    elements.toggle.disabled = false;
  }
});

elements.connect.addEventListener("click", async () => {
  if (!window.ethereum) {
    elements.connect.textContent = "MetaMask not found";
    return;
  }
  elements.connect.disabled = true;
  try {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    let chainId = Number(await window.ethereum.request({ method: "eth_chainId" }));
    if (currentState?.chainId && chainId !== currentState.chainId) {
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: `0x${currentState.chainId.toString(16)}` }],
        });
        chainId = currentState.chainId;
      } catch {
        elements.connect.textContent = "Switch MetaMask chain";
        return;
      }
    }
    const selected = accounts[0];
    if (
      currentState?.keeperAddress &&
      selected.toLowerCase() !== currentState.keeperAddress.toLowerCase()
    ) {
      elements.connect.textContent = "Select keeper account";
      return;
    }
    elements.connect.textContent = `${selected.slice(0, 6)}…${selected.slice(-4)}`;
    elements.connect.title = `Connected on chain ${chainId}`;
  } catch {
    elements.connect.textContent = "MetaMask declined";
  } finally {
    elements.connect.disabled = false;
  }
});

const events = new EventSource("/api/events");
events.onmessage = (event) => render(JSON.parse(event.data));
fetch("/api/state").then((response) => response.json()).then(render);
setInterval(() => {
  if (currentState) render(currentState);
}, 1000);
