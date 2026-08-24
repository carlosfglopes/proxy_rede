// scripts/simulate_formation_v1.js
// Formation scenario simulation with V1 logic — multiple scenarios.
//
// Usage:
//   npx hardhat run scripts/simulate_formation_v1.js --network rede-proxy
//   $env:SCENARIO="nominal";          npx hardhat run scripts/simulate_formation_v1.js --network rede-proxy
//   $env:SCENARIO="violation";        npx hardhat run scripts/simulate_formation_v1.js --network rede-proxy
//   $env:SCENARIO="late";             npx hardhat run scripts/simulate_formation_v1.js --network rede-proxy
//   $env:SCENARIO="formation_change"; npx hardhat run scripts/simulate_formation_v1.js --network rede-proxy
//
// Prerequisite: npm run deploy:formation

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// CONFIGURATION

const SCENARIO = process.env.SCENARIO || "violation";

const UAV_ADDRESSES = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
];

const LINE_POS = [
  { x:    0, y: 0 },
  { x: 3000, y: 0 },
  { x: 6000, y: 0 },
];

const V_POS = [
  { x: 1500, y:    0 },
  { x: 3000, y: 2000 },
  { x: 4500, y:    0 },
];

const VIOLATION_POS = { x: 12000, y: 0 };

const GAS = { gasLimit: 3_000_000 };

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

function missionStateLabel(v) {
  return ["SETUP","ACTIVE","RECONFIGURING","DEGRADED","COMPLETED","ABORTED"][Number(v)] ?? `UNKNOWN(${v})`;
}

function uavStateLabel(v) {
  return ["OK","LATE","OUT_OF_FORMATION","INACTIVE"][Number(v)] ?? `UNKNOWN(${v})`;
}

function formationLabel(id) {
  return ["LINE","V","CIRCLE"][Number(id)] ?? `CUSTOM(${id})`;
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
  const s        = await proxy.getSwarmSummary();
  const c        = await proxy.getSwarmCounts();
  const [cx, cy] = await proxy.getCentroid();
  const quorum   = await proxy.quorum();

  console.log("\n  ── Swarm State ───────────────────────────");
  console.log("  State      :", missionStateLabel(s.state));
  console.log(`  Formation  : ${formationLabel(s.formationId)} (id=${s.formationId})`);
  console.log(`  Centroid   : (${cx}, ${cy})`);
  console.log(`  UAVs total : ${s.totalUAVs}`);
  console.log(`  Counts     : OK=${c.okCount} LATE=${c.lateCount} OUT=${c.outOfFormationCount} INACTIVE=${c.inactiveCount}`);
  console.log(`  Quorum     : ${quorum} votes`);
  if (s.inTransition) {
    console.log(`  Transition : in progress | ${s.transitionSecsLeft}s left`);
  }

  console.log("\n  ── UAV State ─────────────────────────────");
  for (let i = 0; i < UAV_ADDRESSES.length; i++) {
    const u = await proxy.uavs(UAV_ADDRESSES[i]);
    if (!u.registered) continue;
    const st = await proxy.getUAVStatus(UAV_ADDRESSES[i]);
    console.log(
      `  UAV${i+1} (${UAV_ADDRESSES[i].slice(0,10)}…)` +
      `  state=${uavStateLabel(st.state).padEnd(18)}` +
      `  pos=(${String(st.x).padStart(6)},${String(st.y).padStart(5)})` +
      `  viol=${st.violationCount}` +
      `  vVotes=${st.votes}/${quorum}` +
      `  rVotes=${st.recovVotes}/${quorum}`
    );
  }
}

// SETUP

async function setupAndStart(proxy, deployer, positions) {
  sep("SETUP — Register + Start");

  for (let i = 0; i < UAV_ADDRESSES.length; i++) {
    await sendTx(
      proxy.connect(deployer).registerUAV(UAV_ADDRESSES[i], positions[i].x, positions[i].y, GAS),
      `registerUAV UAV${i+1} (${positions[i].x},${positions[i].y})`
    );
    console.log(`  ✔ UAV${i+1}: ${UAV_ADDRESSES[i]}`);
  }

  await sendTx(proxy.connect(deployer).startMission(GAS), "startMission");
  console.log("  ✔ Mission started → ACTIVE");
}

async function positionRound(proxy, deployer, positions, label, skipIdx = -1) {
  sep(label);
  for (let i = 0; i < UAV_ADDRESSES.length; i++) {
    if (i === skipIdx) {
      console.log(`  UAV${i+1}: no update (deliberate)`);
      continue;
    }
    await sendTx(
      proxy.connect(deployer).updatePosition(UAV_ADDRESSES[i], positions[i].x, positions[i].y, GAS),
      `updatePosition UAV${i+1} (${positions[i].x},${positions[i].y})`
    );
  }
}

// SCENARIO: NOMINAL

async function runNominal(proxy, deployer) {
  console.log("\n  Continuous monitoring — 3 rounds in LINE formation");

  for (let round = 1; round <= 3; round++) {
    await positionRound(proxy, deployer, LINE_POS, `ROUND ${round} — Valid Positions (LINE)`);
    await printSummary(proxy);
  }
}

// SCENARIO: VIOLATION

async function runViolation(proxy, deployer) {
  await positionRound(proxy, deployer, LINE_POS, "ROUND 1 — Valid Positions");
  await printSummary(proxy);

  const ronda2 = [...LINE_POS];
  ronda2[2] = VIOLATION_POS;

  await positionRound(proxy, deployer, ronda2, "ROUND 2 — UAV3 Drifts to VIOLATION_POS");

  sep("ROUND 2 — UAV1+UAV2 Report Violation of UAV3 → violationCount=1");
  await sendTx(
    proxy.connect(deployer).reportViolation(UAV_ADDRESSES[0], UAV_ADDRESSES[2], GAS),
    "reportViolation UAV1 → UAV3"
  );
  await sendTx(
    proxy.connect(deployer).reportViolation(UAV_ADDRESSES[1], UAV_ADDRESSES[2], GAS),
    "reportViolation UAV2 → UAV3  ← quorum → violationCount=1"
  );
  console.log("  ✔ Quorum reached → violationCount UAV3 = 1");
  await printSummary(proxy);

  await positionRound(proxy, deployer, ronda2, "ROUND 3 — UAV3 Stays at VIOLATION_POS");

  sep("ROUND 3 — UAV1+UAV2 Report → violationCount=2 → OUT_OF_FORMATION → DEGRADED");
  await sendTx(
    proxy.connect(deployer).reportViolation(UAV_ADDRESSES[0], UAV_ADDRESSES[2], GAS),
    "reportViolation UAV1 → UAV3"
  );
  await sendTx(
    proxy.connect(deployer).reportViolation(UAV_ADDRESSES[1], UAV_ADDRESSES[2], GAS),
    "reportViolation UAV2 → UAV3  ← quorum → OUT_OF_FORMATION → DEGRADED"
  );
  console.log("  ✔ violationCount=2 → UAV3 OUT_OF_FORMATION → mission DEGRADED");
  await printSummary(proxy);

  await positionRound(proxy, deployer, LINE_POS,
    "ROUND 4 — UAV3 Returns to LINE_POS (votes cleared, OUT holds until confirmation)");
  await printSummary(proxy);

  sep("ROUND 4b — UAV1+UAV2 Confirm Recovery → UAV3 OK → ACTIVE");
  await sendTx(
    proxy.connect(deployer).reportRecovery(UAV_ADDRESSES[0], UAV_ADDRESSES[2], GAS),
    "reportRecovery UAV1 → UAV3"
  );
  await sendTx(
    proxy.connect(deployer).reportRecovery(UAV_ADDRESSES[1], UAV_ADDRESSES[2], GAS),
    "reportRecovery UAV2 → UAV3  ← quorum → UAV3 OK → ACTIVE"
  );
  console.log("  ✔ Recovery quorum reached → UAV3 OK → mission ACTIVE");
}

// SCENARIO: LATE

async function runLate(proxy, deployer) {
  await positionRound(proxy, deployer, LINE_POS, "ROUND 1 — All Report");
  await printSummary(proxy);

  sep("PAUSE — UAV3 Silent");
  const toleranceSec = Number(await proxy.toleranceWindow());
  const waitSec      = toleranceSec + 2;
  console.log(`  UAV3 sends nothing for ${waitSec}s (toleranceWindow=${toleranceSec}s)`);
  console.log("  UAV1 and UAV2 report AFTER the timeout — their lastUpdate stays fresh");

  await increaseTime(waitSec);

  await sendTx(
    proxy.connect(deployer).updatePosition(UAV_ADDRESSES[0], LINE_POS[0].x, LINE_POS[0].y, GAS),
    "updatePosition UAV1 (fresh)"
  );
  await sendTx(
    proxy.connect(deployer).updatePosition(UAV_ADDRESSES[1], LINE_POS[1].x, LINE_POS[1].y, GAS),
    "updatePosition UAV2 (fresh)"
  );

  await sendTx(proxy.connect(deployer).checkLateUAVs(GAS), "checkLateUAVs");
  console.log("  → UAV3 should be LATE; UAV1 and UAV2 OK → 1 non-OK < degradedThreshold=2 → ACTIVE");
  await printSummary(proxy);

  await positionRound(proxy, deployer, LINE_POS,
    "RECOVERY — UAV3 Reports Again → LATE → OK → ACTIVE");
  console.log("  ✔ UAV3 is back → LATE auto-resets to OK (no quorum needed)");
  await printSummary(proxy);
}

// SCENARIO: FORMATION CHANGE

async function runFormationChange(proxy, deployer) {
  await positionRound(proxy, deployer, LINE_POS, "ROUND 1 — LINE Formation (Valid)");
  await printSummary(proxy);

  sep("FORMATION CHANGE: LINE → V");
  const transitionSec = Number(await proxy.transitionTime());
  console.log(`  Grace period: ${transitionSec}s — violations not penalized during transition`);

  await sendTx(
    proxy.connect(deployer).changeFormation(
      1,
      4_000_000,
      64_000_000,
      25_000_000,
      GAS
    ),
    "changeFormation LINE → V"
  );
  console.log("  ✔ Mission in RECONFIGURING_FORMATION — grace period active");
  await printSummary(proxy);

  await positionRound(proxy, deployer, V_POS,
    "TRANSITION — UAVs Reposition to V Formation (no penalty)");
  await printSummary(proxy);

  sep("END OF GRACE PERIOD");
  const waitSec = transitionSec + 1;
  console.log(`  Waiting ${waitSec}s to end the transition...`);
  await increaseTime(waitSec);

  await sendTx(proxy.connect(deployer).finalizeFormationChange(GAS), "finalizeFormationChange");
  console.log("  ✔ V formation applied — validation resumed with new constraints");
  await printSummary(proxy);

  await positionRound(proxy, deployer, V_POS,
    "ROUND 2 — Valid V Positions Post-Transition");
  console.log("  ✔ All UAVs OK in the new V formation");
  await printSummary(proxy);
}

// MAIN

async function main() {
  const addrPath = path.join(__dirname, "..", "formation_addresses.json");
  if (!fs.existsSync(addrPath)) throw new Error("formation_addresses.json not found.");
  const addresses  = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  const [deployerRaw] = await hre.ethers.getSigners();
  const deployer      = new hre.ethers.NonceManager(deployerRaw);
  const proxy         = await hre.ethers.getContractAt("MissionFormationV1", addresses.proxy);

  sep("MissionFormation (V1) — Scenario: " + SCENARIO.toUpperCase());
  console.log("  Network   :", hre.network.name);
  console.log("  Proxy     :", addresses.proxy);
  console.log("  Version   :", await proxy.version());
  console.log("  Scenario  :", SCENARIO);
  console.log("  Deployer  :", deployer.address);
  UAV_ADDRESSES.forEach((a, i) => console.log(`  UAV${i+1}      : ${a}`));

  const initPositions = SCENARIO === "formation_change" ? LINE_POS : LINE_POS;
  await setupAndStart(proxy, deployer, initPositions);

  if      (SCENARIO === "nominal")          await runNominal(proxy, deployer);
  else if (SCENARIO === "violation")        await runViolation(proxy, deployer);
  else if (SCENARIO === "late")             await runLate(proxy, deployer);
  else if (SCENARIO === "formation_change") await runFormationChange(proxy, deployer);
  else throw new Error(`Invalid scenario: "${SCENARIO}". Use: nominal | violation | late | formation_change`);

  sep("FINAL RESULT");
  await printSummary(proxy);

  sep("END");
}

main().catch((err) => {
  console.error("✘ Error:", err.message);
  process.exitCode = 1;
});
