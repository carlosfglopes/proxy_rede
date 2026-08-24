// scripts/authority_formation.js
// Authority — MissionFormation (Model 2: Proxy/Upgradeability). Runs on
// the PC. Registers the UAVs (SQUARE formation positions, 4 UAVs), starts
// the mission, and monitors until deciding to close it. The agents
// (agent_formation.py, one per RPi) handle self service: they report
// their own position and vote on peer violations/recoveries.
//
// Usage:
//   npx hardhat run scripts/authority_formation.js --network rede-proxy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { trackAuthorityTx, finishAndSaveMetrics } = require("./lib/metrics");

const UAVS = [
  { addr: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", x: 0,    y: 0    },
  { addr: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", x: 4000, y: 0    },
  { addr: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", x: 4000, y: 4000 },
  { addr: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", x: 0,    y: 4000 },
];

const MONITOR_ROUNDS   = 15;
const MONITOR_INTERVAL = 3000;
const GAS = { gasLimit: 500_000 };

// HELPERS

function sep(label) {
  console.log(`\n${"─".repeat(50)}`);
  if (label) console.log(`  ${label}`);
  console.log("─".repeat(50));
}

function log(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [AUTHORITY] ${msg}`);
}

async function sendTx(promise, label) {
  const tx      = await promise;
  const receipt = await tx.wait();
  log(`[${label}] gas: ${receipt.gasUsed.toString()} | block: ${receipt.blockNumber}`);
  trackAuthorityTx(receipt, label);
  return receipt;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// MAIN

async function main() {
  const addrPath = path.join(__dirname, "..", "formation_addresses.json");
  if (!fs.existsSync(addrPath)) throw new Error("formation_addresses.json not found — run deploy_formation.js first.");
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));

  const [authority] = await hre.ethers.getSigners();
  const proxy        = await hre.ethers.getContractAt("MissionFormationV1", addresses.proxy);
  const fromBlock     = await hre.ethers.provider.getBlockNumber();

  sep("AUTHORITY — MissionFormation (Model 2)");
  log(`Network   : ${hre.network.name}`);
  log(`Authority : ${authority.address}`);
  log(`Proxy     : ${addresses.proxy}`);

  sep("STEP 1 — Register UAVs (SQUARE formation)");
  for (let i = 0; i < UAVS.length; i++) {
    const existing = await proxy.uavs(UAVS[i].addr);
    if (existing.registered) {
      log(`UAV${i + 1} already registered.`);
      continue;
    }
    await sendTx(
      proxy.connect(authority).registerUAV(UAVS[i].addr, UAVS[i].x, UAVS[i].y, GAS),
      `registerUAV UAV${i + 1} (${UAVS[i].x},${UAVS[i].y})`
    );
  }

  sep("STEP 2 — Start Mission");
  const active = await proxy.missionActive();
  if (!active) {
    await sendTx(proxy.connect(authority).startMission(GAS), "startMission");
  } else {
    log("Mission already active.");
  }

  sep(`STEP 3 — Monitor (${MONITOR_ROUNDS} rounds)`);
  for (let round = 1; round <= MONITOR_ROUNDS; round++) {
    const s = await proxy.getSwarmSummary();
    const c = await proxy.getSwarmCounts();
    const [cx, cy] = await proxy.getCentroid();

    log(
      `Round ${round}/${MONITOR_ROUNDS} | active=${s.active} completed=${s.completed} ` +
      `aborted=${s.abortedFlag} degraded=${s.degradedFlag} | centroid=(${cx},${cy}) | ` +
      `OK=${c.okCount} LATE=${c.lateCount} OUT=${c.outOfFormationCount} INACTIVE=${c.inactiveCount}`
    );

    if (s.completed || s.abortedFlag) {
      log("Mission already ended on its own.");
      break;
    }
    await sleep(MONITOR_INTERVAL);
  }

  sep("STEP 4 — Close Mission");
  const final = await proxy.getSwarmSummary();
  if (!final.completed && !final.abortedFlag) {
    await sendTx(proxy.connect(authority).completeMission(GAS), "completeMission");
    log("Mission closed successfully (COMPLETED).");
  } else {
    log(`Mission was already finished (completed=${final.completed}, aborted=${final.abortedFlag}).`);
  }

  sep("METRICS");
  await finishAndSaveMetrics({
    provider: hre.ethers.provider, proxyAddress: addresses.proxy, iface: proxy.interface,
    fromBlock, model: "Modelo2-Proxy", scenario: "Formation", log,
  });

  sep("END");
}

main().catch((err) => {
  console.error("✘ Error:", err.message);
  process.exitCode = 1;
});
