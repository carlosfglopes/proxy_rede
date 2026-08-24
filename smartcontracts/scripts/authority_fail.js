// scripts/authority_fail.js
// Authority — MissionFail (Failure Response, Model 2). Registers UAVs,
// creates tasks, starts the mission, simulates a malicious behavior
// incident on UAV4, waits for agent votes, finalizes the incident, and
// reconfigures.
//
// Usage:
//   npx hardhat run scripts/authority_fail.js --network rede-proxy

const hre    = require("hardhat");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const { trackAuthorityTx, finishAndSaveMetrics } = require("./lib/metrics");

const UAV_ADDRESSES = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
];
const UAV_CAPACITIES = [2, 2, 2, 2];
const INITIAL_TASKS = [
  [1, UAV_ADDRESSES[0]],
  [2, UAV_ADDRESSES[1]],
  [3, UAV_ADDRESSES[2]],
  [4, UAV_ADDRESSES[3]],
];

const SIMULATE_DELAY  = 30;
const SIMULATE_TARGET = UAV_ADDRESSES[3];
const POLL_INTERVAL   = 2000;
const GAS = { gasLimit: 500_000 };

// HELPERS

function stateLabel(s) {
  if (s.abortedFlag)  return "ABORTED";
  if (s.completed)    return "COMPLETED";
  if (s.suspect !== "0x0000000000000000000000000000000000000000") return "UNDER_CONFIRMATION";
  if (s.degradedFlag) return "DEGRADED";
  if (s.active)        return "ACTIVE";
  return "SETUP";
}

function sep(label) {
  console.log(`\n${"─".repeat(50)}`);
  if (label) console.log(`  ${label}`);
  console.log("─".repeat(50));
}
function log(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [AUTHORITY] ${msg}`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendTx(promise, label) {
  const tx      = await promise;
  const receipt = await tx.wait();
  log(`[${label}] gas: ${receipt.gasUsed.toString()} | block: ${receipt.blockNumber}`);
  trackAuthorityTx(receipt, label);
  return receipt;
}

// MAIN

async function main() {
  const addrPath = path.join(__dirname, "..", "proxy_addresses.json");
  if (!fs.existsSync(addrPath)) throw new Error("proxy_addresses.json not found — run deploy_proxy.js first.");
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));

  const [authority] = await hre.ethers.getSigners();
  const proxy        = await hre.ethers.getContractAt("MissionFailV1", addresses.proxy);
  const fromBlock    = await hre.ethers.provider.getBlockNumber();

  sep("AUTHORITY — MissionFail (Model 2)");
  log(`Network   : ${hre.network.name}`);
  log(`Authority : ${authority.address}`);
  log(`Proxy     : ${addresses.proxy}`);

  sep("STEP 1 — Register UAVs");
  for (let i = 0; i < UAV_ADDRESSES.length; i++) {
    const data = await proxy.uavs(UAV_ADDRESSES[i]);
    if (data.registered) {
      log(`UAV${i + 1} already registered.`);
      continue;
    }
    await sendTx(
      proxy.connect(authority).registerUAV(UAV_ADDRESSES[i], UAV_CAPACITIES[i], GAS),
      `registerUAV UAV${i + 1} cap=${UAV_CAPACITIES[i]}`
    );
  }

  sep("STEP 2 — Create Tasks");
  for (const [taskId, assignedTo] of INITIAL_TASKS) {
    await sendTx(proxy.connect(authority).createTask(taskId, assignedTo, GAS), `createTask ${taskId} → ${assignedTo}`);
  }

  sep("STEP 3 — Start Mission");
  await sendTx(proxy.connect(authority).startMission(GAS), "startMission");

  sep(`STEP 4 — Normal Phase (${SIMULATE_DELAY}s)`);
  log(`UAVs sending heartbeats. Simulating failure of ${SIMULATE_TARGET} in ${SIMULATE_DELAY}s`);
  await sleep(SIMULATE_DELAY * 1000);

  sep("STEP 5 — Open Incident (Malicious Behavior on UAV4)");
  const evidence = "0x" + crypto.createHash("sha256").update(`byzantine-${Date.now()}`).digest("hex");
  await sendTx(
    proxy.connect(authority).openBehaviorIncident(SIMULATE_TARGET, evidence, GAS),
    "openBehaviorIncident"
  );

  sep("STEP 6 — Wait for Votes");
  const quorum = await proxy.quorumThreshold();
  log(`Quorum required: ${quorum}`);

  const ZERO = "0x0000000000000000000000000000000000000000";
  while (true) {
    const s = await proxy.getMissionSummary();
    const underConfirmation = s.suspect !== ZERO;
    log(`State: ${stateLabel(s)} | Votes — Failed:${s.vFailed} Byzantine:${s.vByzantine} Reject:${s.vReject}`);

    if (underConfirmation) {
      if (s.vFailed >= quorum || s.vByzantine >= quorum || s.vReject >= quorum) {
        log("Quorum reached! Finalizing incident...");
        await sendTx(proxy.connect(authority).finalizeIncident(GAS), "finalizeIncident");
        break;
      }
    } else {
      break;
    }
    await sleep(POLL_INTERVAL);
  }

  sep("STEP 7 — Reconfigure");
  if (await proxy.reconfigurationPending()) {
    await sendTx(proxy.connect(authority).triggerReconfiguration(GAS), "triggerReconfiguration");
  }

  sep("STEP 8 — Final Monitoring");
  let finished = false;
  for (let i = 0; i < 10; i++) {
    const s = await proxy.getMissionSummary();
    log(`State: ${stateLabel(s)} | Failures: ${s.failures} | Active UAVs: ${s.activeUAVs} | Tasks: ${s.activeTasks}`);
    if (s.abortedFlag) {
      log("Mission ABORTED.");
      finished = true;
      break;
    }
    await sleep(POLL_INTERVAL);
  }

  if (!finished) {
    const s = await proxy.getMissionSummary();
    if (s.active) {
      log("Mission healthy with no new failures — closing with completeMission()...");
      await sendTx(proxy.connect(authority).completeMission(GAS), "completeMission");
    } else {
      log(`Mission ended in unexpected state: ${stateLabel(s)}`);
    }
  }

  sep("STEP 9 — Task Summary");
  for (const [taskId, originalAssignee] of INITIAL_TASKS) {
    const t = await proxy.getTaskSummary(taskId);
    const reassigned = t.assignedTo.toLowerCase() !== originalAssignee.toLowerCase();
    const status = !t.active
      ? "completed/inactive"
      : t.assignedTo === "0x0000000000000000000000000000000000000000"
        ? "NO ASSIGNEE (could not reassign)"
        : reassigned
          ? `reassigned → ${t.assignedTo} (load ${t.assigneeLoad}/${t.assigneeCapacity})`
          : `kept on original UAV (load ${t.assigneeLoad}/${t.assigneeCapacity})`;
    log(`Task ${taskId} (orig. ${originalAssignee}): ${status}`);
  }

  sep("METRICS");
  await finishAndSaveMetrics({
    provider: hre.ethers.provider, proxyAddress: addresses.proxy, iface: proxy.interface,
    fromBlock, model: "Modelo2-Proxy", scenario: "Fail", log,
  });

  sep("END");
}

main().catch((err) => {
  console.error("✘ Error:", err.message);
  process.exitCode = 1;
});
