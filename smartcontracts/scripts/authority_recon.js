// scripts/authority_recon.js
// Authority — MissionRecon (Model 2: Proxy/Upgradeability). Runs on the
// PC. Permits the UAVs, activates the mission, and triggers the election.
// From there, the agents (agent_recon.py, one per RPi) handle
// registration, status publishing, and report submission (if elected).
//
// Usage:
//   npx hardhat run scripts/authority_recon.js --network rede-proxy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { trackAuthorityTx, finishAndSaveMetrics } = require("./lib/metrics");

const UAV_ADDRESSES = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
];

const MISSION_ZONE   = "Zone-Alpha";
const POLL_INTERVAL  = 2000;
const GAS = { gasLimit: 3_000_000 };

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

function reportLabel(v) {
  return ["NONE", "TARGET_DETECTED", "NOTHING_FOUND", "INCONCLUSIVE"][Number(v)] ?? `UNKNOWN(${v})`;
}

// MAIN

async function main() {
  const addrPath = path.join(__dirname, "..", "recon_addresses.json");
  if (!fs.existsSync(addrPath)) throw new Error("recon_addresses.json not found — run deploy_recon.js first.");
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));

  const [deployer] = await hre.ethers.getSigners();
  const proxy       = await hre.ethers.getContractAt("MissionReconV1", addresses.proxy);
  const fromBlock   = await hre.ethers.provider.getBlockNumber();

  sep("AUTHORITY — MissionRecon (Model 2)");
  log(`RPC/Network: ${hre.network.name}`);
  log(`Authority  : ${deployer.address}`);
  log(`Proxy      : ${addresses.proxy}`);

  sep("STEP 1 — Permit UAVs");
  for (let i = 0; i < UAV_ADDRESSES.length; i++) {
    const uav = await proxy.uavs(UAV_ADDRESSES[i]);
    if (!uav.permitted) {
      await sendTx(proxy.connect(deployer).permitUAV(UAV_ADDRESSES[i], GAS), `permitUAV UAV${i + 1}`);
    } else {
      log(`UAV${i + 1} already permitted.`);
    }
  }

  sep("STEP 2 — Activate Mission");
  const alreadyActive = await proxy.missionActive();
  if (!alreadyActive) {
    await sendTx(proxy.connect(deployer).activateMission(MISSION_ZONE, GAS), "activateMission");
  } else {
    log("Mission already active.");
  }

  sep("STEP 3 — Wait for Registration and Status of All Permitted UAVs");
  const minUAVs = Number(await proxy.minUAVsForElection());
  log(`minUAVsForElection = ${minUAVs}`);

  while (true) {
    const registeredCount = await proxy.getRegisteredUAVCount();
    log(`Registered UAVs: ${registeredCount}/${minUAVs}+`);

    if (Number(registeredCount) >= minUAVs) {
      let allHaveStatus = true;
      for (let i = 0; i < UAV_ADDRESSES.length; i++) {
        const uav = await proxy.uavs(UAV_ADDRESSES[i]);
        if (uav.registered && !uav.hasStatus) allHaveStatus = false;
      }
      if (allHaveStatus) break;
      log("Waiting for publishStatus from registered UAVs...");
    }
    await sleep(POLL_INTERVAL);
  }

  sep("STEP 4 — Start Election");
  await sendTx(proxy.connect(deployer).startElection(GAS), "startElection");
  const leader = await proxy.electedLeader();
  const idx    = UAV_ADDRESSES.findIndex(a => a.toLowerCase() === leader.toLowerCase());
  log(`Elected leader: UAV${idx + 1} (${leader})`);

  sep("STEP 5 — Monitor Until Final Report");
  const reportTimeoutSec = Number(await proxy.reportTimeoutSec());
  log(`reportTimeoutSec = ${reportTimeoutSec}s`);

  while (true) {
    const summary = await proxy.getMissionSummary();
    log(`completed=${summary.completed} leader=${summary.leader.slice(0, 10)}… report=${reportLabel(summary.report)} reelections=${summary.reelections}`);

    if (summary.completed) {
      log("Mission COMPLETED.");
      break;
    }

    const electionTs = Number(await proxy.electionTimestamp());
    const nowSec      = Math.floor(Date.now() / 1000);
    if (nowSec > electionTs + reportTimeoutSec) {
      try {
        await sendTx(proxy.connect(deployer).checkTimeout(GAS), "checkTimeout");
        const newLeader = await proxy.electedLeader();
        const newIdx    = UAV_ADDRESSES.findIndex(a => a.toLowerCase() === newLeader.toLowerCase());
        log(`Previous leader timed out → new leader: UAV${newIdx + 1} (${newLeader})`);
      } catch (e) {
        log(`checkTimeout not yet applicable: ${e.message}`);
      }
    }

    await sleep(POLL_INTERVAL);
  }

  sep("METRICS");
  await finishAndSaveMetrics({
    provider: hre.ethers.provider, proxyAddress: addresses.proxy, iface: proxy.interface,
    fromBlock, model: "Modelo2-Proxy", scenario: "Recon", log,
  });

  sep("END");
}

main().catch((err) => {
  console.error("✘ Error:", err.message);
  process.exitCode = 1;
});
