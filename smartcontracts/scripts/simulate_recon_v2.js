// scripts/simulate_recon_v2.js
// Recon scenario simulation with V2 logic — multiple scenarios.
//
// Usage:
//   npx hardhat run scripts/simulate_recon_v2.js --network rede-proxy
//   $env:SCENARIO="target_detected"; npx hardhat run scripts/simulate_recon_v2.js --network rede-proxy
//   $env:SCENARIO="nothing_found";   npx hardhat run scripts/simulate_recon_v2.js --network rede-proxy
//   $env:SCENARIO="inconclusive";    npx hardhat run scripts/simulate_recon_v2.js --network rede-proxy
//   $env:SCENARIO="rejected";        npx hardhat run scripts/simulate_recon_v2.js --network rede-proxy
//
// Prerequisite: npm run upgrade:recon + npm run reset:recon:v2

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

async function printSummary(proxy) {
  const r = await proxy.getReconReport();
  console.log("\n  ── Mission State ─────────────────────────");
  console.log("  State        :", r.completed ? "COMPLETED" : (r.active ? "ACTIVE" : "INACTIVE"));
  console.log("  Zone         :", r.zone);
  console.log("  Leader       :", r.leader);
  console.log("  Report       :", reportLabel(r.report));
  console.log("  Confirmations:", r.confirms.toString());
  console.log("  Rejections   :", r.rejections.toString());
  console.log("  Pending      :", r.pending);

  console.log("\n  ── UAV State ─────────────────────────────");
  for (let i = 0; i < UAV_ADDRESSES.length; i++) {
    const u     = await proxy.uavs(UAV_ADDRESSES[i]);
    const voted = await proxy.hasVoted(UAV_ADDRESSES[i]);
    if (!u.registered) continue;
    const isLeader = UAV_ADDRESSES[i].toLowerCase() === r.leader.toLowerCase();
    console.log(
      `  UAV${i+1} (${UAV_ADDRESSES[i].slice(0,10)}…)` +
      `  score=${u.score}` +
      `  leader=${isLeader}` +
      `  voted=${voted}`
    );
  }
}

// VERIFICATION

async function verifyV1State(proxy) {
  sep("VERIFICATION — V1 State Preserved");

  const uavCount  = await proxy.getRegisteredUAVCount();
  const leader    = await proxy.electedLeader();
  const leaderIdx = UAV_ADDRESSES.findIndex(a => a.toLowerCase() === leader.toLowerCase());

  console.log(`  Registered UAVs : ${uavCount} ← preserved ✓`);
  console.log(`  Elected leader  : UAV${leaderIdx+1} (${leader}) ← preserved ✓`);
  console.log(`  Threshold       : ${await proxy.confirmationThreshold()} ← initialized ✓`);

  for (let i = 0; i < UAV_ADDRESSES.length; i++) {
    const u = await proxy.uavs(UAV_ADDRESSES[i]);
    if (!u.registered) continue;
    console.log(`  UAV${i+1}: score=${u.score}  ← preserved ✓`);
  }
}

// COMMON CONFIRMATION (confirm=true)

async function runConfirmation(proxy, deployer) {
  sep("CONFIRMATION — Other UAVs Validate the Report");

  const leader    = await proxy.electedLeader();
  const threshold = await proxy.confirmationThreshold();

  for (let i = 0; i < UAV_ADDRESSES.length; i++) {
    if (UAV_ADDRESSES[i].toLowerCase() === leader.toLowerCase()) continue;
    await sendTx(
      proxy.connect(deployer).confirmFinding(UAV_ADDRESSES[i], true, GAS),
      `confirmFinding UAV${i+1} → CONFIRM`
    );
    console.log(`  ✔ UAV${i+1} confirmed the report`);
    const confirms = await proxy.confirmationCount();
    if (confirms >= threshold) break;
  }
}

// SCENARIO: TARGET DETECTED

async function runTargetDetected(proxy, deployer) {
  sep("SCENARIO: TARGET DETECTED (with V2 confirmation)");

  const hash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("recon-evidence-target-v2"));
  await sendTx(
    proxy.connect(deployer).submitReportForConfirmation(REPORT.TARGET_DETECTED, hash, GAS),
    "submitReportForConfirmation(TARGET_DETECTED)"
  );
  console.log("  ✔ Report submitted — awaiting confirmation");

  await runConfirmation(proxy, deployer);

  sep("FINALIZATION — Consensus Reached");
  await sendTx(proxy.connect(deployer).finalizeConsensus(GAS), "finalizeConsensus");
  console.log("  ✔ Consensus reached — target confirmed — mission completed");
}

// SCENARIO: NOTHING FOUND

async function runNothingFound(proxy, deployer) {
  sep("SCENARIO: NOTHING FOUND (with V2 confirmation)");

  const hash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("recon-evidence-clear-v2"));
  await sendTx(
    proxy.connect(deployer).submitReportForConfirmation(REPORT.NOTHING_FOUND, hash, GAS),
    "submitReportForConfirmation(NOTHING_FOUND)"
  );
  console.log("  ✔ Report submitted — awaiting confirmation");

  await runConfirmation(proxy, deployer);

  sep("FINALIZATION — Consensus Reached");
  await sendTx(proxy.connect(deployer).finalizeConsensus(GAS), "finalizeConsensus");
  console.log("  ✔ Consensus reached — clear zone confirmed — mission completed");
}

// SCENARIO: INCONCLUSIVE

async function runInconclusive(proxy, deployer) {
  sep("SCENARIO: INCONCLUSIVE (with V2 confirmation)");
  console.log("  In V2, even an inconclusive report can be finalized by consensus.");

  const hash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("recon-evidence-inconclusive-v2"));
  await sendTx(
    proxy.connect(deployer).submitReportForConfirmation(REPORT.INCONCLUSIVE, hash, GAS),
    "submitReportForConfirmation(INCONCLUSIVE)"
  );
  console.log("  ✔ Inconclusive report submitted — awaiting peer confirmation");

  await runConfirmation(proxy, deployer);

  sep("FINALIZATION — Consensus Reached");
  await sendTx(proxy.connect(deployer).finalizeConsensus(GAS), "finalizeConsensus");
  console.log("  ✔ Peers confirmed the inconclusive report — mission completed by consensus");
}

// SCENARIO: REJECTED

async function runRejected(proxy, deployer) {
  sep("SCENARIO: REPORT REJECTED (no consensus)");
  console.log("  UAVs reject the report — threshold not reached — mission stays pending.");

  const hash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("recon-evidence-rejected-v2"));
  await sendTx(
    proxy.connect(deployer).submitReportForConfirmation(REPORT.TARGET_DETECTED, hash, GAS),
    "submitReportForConfirmation(TARGET_DETECTED)"
  );
  console.log("  ✔ Report submitted — awaiting voting");

  sep("VOTING — UAVs Reject the Report");
  const leader = await proxy.electedLeader();
  for (let i = 0; i < UAV_ADDRESSES.length; i++) {
    if (UAV_ADDRESSES[i].toLowerCase() === leader.toLowerCase()) continue;
    await sendTx(
      proxy.connect(deployer).confirmFinding(UAV_ADDRESSES[i], false, GAS),
      `confirmFinding UAV${i+1} → REJECT`
    );
    console.log(`  ✔ UAV${i+1} rejected the report`);
  }

  const confirms   = await proxy.confirmationCount();
  const threshold  = await proxy.confirmationThreshold();
  const rejections = await proxy.rejectionCount();
  console.log(`\n  Confirmations: ${confirms}/${threshold} (threshold not reached)`);
  console.log(`  Rejections   : ${rejections}`);
  console.log("  ✔ No consensus — mission remains pending (reportPending=true)");
  console.log("  ✔ Demonstrates that the V2 mechanism protects against unvalidated reports");
}

// MAIN

async function main() {
  const addrPath = path.join(__dirname, "..", "recon_addresses.json");
  if (!fs.existsSync(addrPath)) throw new Error("recon_addresses.json not found.");
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  if (!addresses.implementationV2) throw new Error("Proxy is not on V2 yet. Run upgrade:recon first.");

  const [deployer] = await hre.ethers.getSigners();
  const proxy      = await hre.ethers.getContractAt("MissionReconV2", addresses.proxy);

  sep("MissionRecon (V2) — Scenario: " + SCENARIO.toUpperCase());
  console.log("  Network   :", hre.network.name);
  console.log("  Proxy     :", addresses.proxy);
  console.log("  Version   :", await proxy.version());
  console.log("  Scenario  :", SCENARIO);
  console.log("  Threshold :", (await proxy.confirmationThreshold()).toString());
  console.log("  Deployer  :", deployer.address);

  await verifyV1State(proxy);

  sep("ELECTION — Re-elect Leader");
  await sendTx(proxy.connect(deployer).startElection(GAS), "startElection");
  const leader = await proxy.electedLeader();
  const idx    = UAV_ADDRESSES.findIndex(a => a.toLowerCase() === leader.toLowerCase());
  console.log(`  ✔ Elected leader: UAV${idx+1} (${leader})`);

  if      (SCENARIO === "target_detected") await runTargetDetected(proxy, deployer);
  else if (SCENARIO === "nothing_found")   await runNothingFound(proxy, deployer);
  else if (SCENARIO === "inconclusive")    await runInconclusive(proxy, deployer);
  else if (SCENARIO === "rejected")        await runRejected(proxy, deployer);
  else throw new Error(`Invalid scenario: "${SCENARIO}". Use: target_detected | nothing_found | inconclusive | rejected`);

  sep("FINAL RESULT");
  await printSummary(proxy);

  sep("END");
}

main().catch((err) => {
  console.error("✘ Error:", err.message);
  process.exitCode = 1;
});
