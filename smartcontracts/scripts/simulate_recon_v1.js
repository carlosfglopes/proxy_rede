// scripts/simulate_recon_v1.js
// Recon scenario simulation with V1 logic — multiple scenarios.
//
// Usage:
//   npx hardhat run scripts/simulate_recon_v1.js --network rede-proxy
//   $env:SCENARIO="target_detected"; npx hardhat run scripts/simulate_recon_v1.js --network rede-proxy
//   $env:SCENARIO="nothing_found";   npx hardhat run scripts/simulate_recon_v1.js --network rede-proxy
//   $env:SCENARIO="inconclusive";    npx hardhat run scripts/simulate_recon_v1.js --network rede-proxy
//   $env:SCENARIO="timeout";         npx hardhat run scripts/simulate_recon_v1.js --network rede-proxy
//
// Prerequisite: npm run deploy:recon

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// CONFIGURATION

const SCENARIO = process.env.SCENARIO || "target_detected";

const UAV_ADDRESSES = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
];

const UAV_PROFILES = [
  { battery: 92, speed: 110 },
  { battery: 78, speed: 140 },
  { battery: 65, speed: 160 },
];

const GAS = { gasLimit: 3_000_000 };

const REPORT = { TARGET_DETECTED: 1, NOTHING_FOUND: 2, INCONCLUSIVE: 3 };

// HELPERS

function sep(label) {
  console.log(`\n${"─".repeat(50)}`);
  if (label) console.log(`  ${label}`);
  console.log("─".repeat(50));
}

async function sendTx(promise, label) {
  const tx      = await promise;
  const receipt = await tx.wait();
  console.log(`  [${label}] gas: ${receipt.gasUsed.toString()} | block: ${receipt.blockNumber}`);
  return receipt;
}

function reportLabel(v) {
  return ["NONE","TARGET_DETECTED","NOTHING_FOUND","INCONCLUSIVE"][Number(v)] ?? `UNKNOWN(${v})`;
}

async function increaseTime(seconds) {
  try {
    await hre.network.provider.send("evm_increaseTime", [seconds]);
    await hre.network.provider.send("evm_mine");
  } catch (e) {
    if (e.message && e.message.includes("Method not found")) {
      console.log(`  (real network: waiting ${seconds}s...)`);
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    } else {
      throw e;
    }
  }
}

async function printSummary(proxy) {
  const s = await proxy.getMissionSummary();
  console.log("\n  ── Mission State ─────────────────────────");
  console.log("  State       :", s.completed ? "COMPLETED" : (s.active ? "ACTIVE" : "INACTIVE"));
  console.log("  Zone        :", s.zone);
  console.log("  Leader      :", s.leader);
  console.log("  Report      :", reportLabel(s.report));
  console.log("  Reelections :", s.reelections.toString());

  console.log("\n  ── UAV State ─────────────────────────────");
  for (let i = 0; i < UAV_ADDRESSES.length; i++) {
    const u = await proxy.uavs(UAV_ADDRESSES[i]);
    if (!u.registered) continue;
    const leader = await proxy.electedLeader();
    console.log(
      `  UAV${i+1} (${UAV_ADDRESSES[i].slice(0,10)}…)` +
      `  bat=${u.battery}  spd=${u.speed}  score=${u.score}` +
      `  ineligible=${u.ineligible}` +
      `  leader=${UAV_ADDRESSES[i].toLowerCase() === leader.toLowerCase()}`
    );
  }
}

// COMMON SETUP

async function setup(proxy, deployer) {
  sep("SETUP — Permit + Activate + Register + Status + Election");

  for (let i = 0; i < UAV_ADDRESSES.length; i++) {
    await sendTx(proxy.connect(deployer).permitUAV(UAV_ADDRESSES[i], GAS), `permitUAV UAV${i+1}`);
  }

  await sendTx(proxy.connect(deployer).activateMission("Zone-Alpha", GAS), "activateMission");
  console.log("  ✔ Mission active → Zone-Alpha");

  for (let i = 0; i < UAV_ADDRESSES.length; i++) {
    await sendTx(proxy.connect(deployer).registerUAV(UAV_ADDRESSES[i], GAS), `registerUAV UAV${i+1}`);
  }

  for (let i = 0; i < UAV_PROFILES.length; i++) {
    const p = UAV_PROFILES[i];
    await sendTx(
      proxy.connect(deployer).publishStatus(UAV_ADDRESSES[i], p.battery, p.speed, GAS),
      `publishStatus UAV${i+1} (bat=${p.battery} spd=${p.speed})`
    );
  }

  await sendTx(proxy.connect(deployer).startElection(GAS), "startElection");
  const leader = await proxy.electedLeader();
  const idx    = UAV_ADDRESSES.findIndex(a => a.toLowerCase() === leader.toLowerCase());
  console.log(`  ✔ Elected leader: UAV${idx+1} (${leader})`);
}

// SCENARIO: TARGET DETECTED

async function runTargetDetected(proxy, deployer) {
  sep("SCENARIO: TARGET DETECTED");

  const evidenceHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("recon-evidence-target"));
  await sendTx(
    proxy.connect(deployer).submitReport(REPORT.TARGET_DETECTED, evidenceHash, GAS),
    "submitReport(TARGET_DETECTED)"
  );
  console.log("  ✔ Target detected — mission completed");
}

// SCENARIO: NOTHING FOUND

async function runNothingFound(proxy, deployer) {
  sep("SCENARIO: NOTHING FOUND");

  const evidenceHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("recon-evidence-clear"));
  await sendTx(
    proxy.connect(deployer).submitReport(REPORT.NOTHING_FOUND, evidenceHash, GAS),
    "submitReport(NOTHING_FOUND)"
  );
  console.log("  ✔ Zone clear — mission completed");
}

// SCENARIO: INCONCLUSIVE → REELECTION

async function runInconclusive(proxy, deployer) {
  sep("SCENARIO: INCONCLUSIVE → REELECTION");

  const leader1 = await proxy.electedLeader();
  const idx1    = UAV_ADDRESSES.findIndex(a => a.toLowerCase() === leader1.toLowerCase());

  const hash1 = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("recon-evidence-inconclusive"));
  await sendTx(
    proxy.connect(deployer).submitReport(REPORT.INCONCLUSIVE, hash1, GAS),
    `submitReport(INCONCLUSIVE) — UAV${idx1+1}`
  );
  console.log(`  ✔ Inconclusive report → UAV${idx1+1} marked ineligible → reelection`);

  const leader2 = await proxy.electedLeader();
  const idx2    = UAV_ADDRESSES.findIndex(a => a.toLowerCase() === leader2.toLowerCase());
  console.log(`  ✔ New leader: UAV${idx2+1} (${leader2})`);

  sep("NEW LEADER SUBMITS FINAL REPORT");
  const hash2 = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("recon-evidence-final"));
  await sendTx(
    proxy.connect(deployer).submitReport(REPORT.TARGET_DETECTED, hash2, GAS),
    `submitReport(TARGET_DETECTED) — UAV${idx2+1}`
  );
  console.log("  ✔ Target confirmed by the new leader — mission completed");
}

// SCENARIO: TIMEOUT → REELECTION

async function runTimeout(proxy, deployer) {
  sep("SCENARIO: LEADER TIMEOUT → REELECTION");

  const leader1    = await proxy.electedLeader();
  const idx1       = UAV_ADDRESSES.findIndex(a => a.toLowerCase() === leader1.toLowerCase());
  const timeoutSec = Number(await proxy.reportTimeoutSec());
  const waitSec    = timeoutSec + 2;

  console.log(`  Current leader: UAV${idx1+1} (${leader1})`);
  console.log(`  Timeout: ${timeoutSec}s — waiting ${waitSec}s without a report...`);

  await increaseTime(waitSec);

  await sendTx(proxy.connect(deployer).checkTimeout(GAS), "checkTimeout");
  console.log(`  ✔ Timeout detected → UAV${idx1+1} marked ineligible → reelection`);

  const leader2 = await proxy.electedLeader();
  const idx2    = UAV_ADDRESSES.findIndex(a => a.toLowerCase() === leader2.toLowerCase());
  console.log(`  ✔ New leader: UAV${idx2+1} (${leader2})`);

  sep("NEW LEADER SUBMITS FINAL REPORT");
  const hash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("recon-evidence-timeout-recovery"));
  await sendTx(
    proxy.connect(deployer).submitReport(REPORT.TARGET_DETECTED, hash, GAS),
    `submitReport(TARGET_DETECTED) — UAV${idx2+1}`
  );
  console.log("  ✔ Mission completed by the new leader after timeout");
}

// MAIN

async function main() {
  const addrPath = path.join(__dirname, "..", "recon_addresses.json");
  if (!fs.existsSync(addrPath)) throw new Error("recon_addresses.json not found.");
  const addresses  = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  const [deployer] = await hre.ethers.getSigners();
  const proxy      = await hre.ethers.getContractAt("MissionReconV1", addresses.proxy);

  sep("MissionRecon (V1) — Scenario: " + SCENARIO.toUpperCase());
  console.log("  Network   :", hre.network.name);
  console.log("  Proxy     :", addresses.proxy);
  console.log("  Version   :", await proxy.version());
  console.log("  Scenario  :", SCENARIO);
  console.log("  Deployer  :", deployer.address);

  await setup(proxy, deployer);

  if      (SCENARIO === "target_detected") await runTargetDetected(proxy, deployer);
  else if (SCENARIO === "nothing_found")   await runNothingFound(proxy, deployer);
  else if (SCENARIO === "inconclusive")    await runInconclusive(proxy, deployer);
  else if (SCENARIO === "timeout")         await runTimeout(proxy, deployer);
  else throw new Error(`Invalid scenario: "${SCENARIO}". Use: target_detected | nothing_found | inconclusive | timeout`);

  sep("FINAL RESULT");
  await printSummary(proxy);

  sep("END");
}

main().catch((err) => {
  console.error("✘ Error:", err.message);
  process.exitCode = 1;
});
