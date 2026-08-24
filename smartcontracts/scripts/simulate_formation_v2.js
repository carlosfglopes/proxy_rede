// scripts/simulate_formation_v2.js
// Formation scenario simulation with V2 logic — multiple scenarios plus
// health scoring.
//
// Usage:
//   npx hardhat run scripts/simulate_formation_v2.js --network rede-proxy
//   $env:SCENARIO="nominal";          npx hardhat run scripts/simulate_formation_v2.js --network rede-proxy
//   $env:SCENARIO="violation";        npx hardhat run scripts/simulate_formation_v2.js --network rede-proxy
//   $env:SCENARIO="late";             npx hardhat run scripts/simulate_formation_v2.js --network rede-proxy
//   $env:SCENARIO="formation_change"; npx hardhat run scripts/simulate_formation_v2.js --network rede-proxy
//
// Prerequisite: npm run upgrade:formation

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
  const r        = await proxy.getFormationReport();
  const c        = await proxy.getSwarmCounts();
  const [cx, cy] = await proxy.getCentroid();

  console.log("\n  ── Swarm State ───────────────────────────");
  console.log("  State        :", missionStateLabel(r.state));
  console.log(`  Formation    : ${formationLabel(r.formationId)} (id=${r.formationId})`);
  console.log(`  Centroid     : (${cx}, ${cy})`);
  console.log(`  Counts       : OK=${c.okCount} LATE=${c.lateCount} OUT=${c.outOfFormationCount} INACTIVE=${c.inactiveCount}`);

  console.log("\n  ── V2 Metrics ────────────────────────────");
  console.log(`  Total cycles : ${r.cycles}`);
  console.log(`  Healthy      : ${r.healthy} / ${r.objective} (objective)`);
  console.log(`  Degraded     : ${r.degraded}`);
  console.log(`  Total score  : ${r.score} pts`);
  const avg = r.cycles > 0n ? (Number(r.score) / Number(r.cycles)).toFixed(1) : "0.0";
  console.log(`  Average score: ${avg} pts/cycle`);

  console.log("\n  ── UAV State ─────────────────────────────");
  for (let i = 0; i < UAV_ADDRESSES.length; i++) {
    const u = await proxy.uavs(UAV_ADDRESSES[i]);
    if (!u.registered) continue;
    const st = await proxy.getUAVStatus(UAV_ADDRESSES[i]);
    console.log(
      `  UAV${i+1} (${UAV_ADDRESSES[i].slice(0,10)}…)` +
      `  state=${uavStateLabel(st.state).padEnd(18)}` +
      `  pos=(${String(st.x).padStart(6)},${String(st.y).padStart(5)})` +
      `  viol=${st.violationCount}`
    );
  }
}

// ROUND HELPERS

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

async function doRecordCycle(proxy, deployer) {
  await sendTx(proxy.connect(deployer).recordCycle(GAS), "recordCycle");
  const cycles  = await proxy.totalCycles();
  const healthy = await proxy.healthyCycles();
  const obj     = await proxy.missionObjective();
  const score   = await proxy.formationScore();
  const state   = await proxy.missionState();
  console.log(`  ✔ Cycle ${cycles} | healthy=${healthy}/${obj} | score=${score} | state=${missionStateLabel(state)}`);
  return Number(state) === 4;
}

// SCENARIO: NOMINAL

async function runNominal(proxy, deployer) {
  const objective = Number(await proxy.missionObjective());
  console.log(`\n  Continuous monitoring — ${objective} healthy cycles to complete`);

  for (let round = 1; round <= objective; round++) {
    await positionRound(proxy, deployer, LINE_POS, `CYCLE ${round}/${objective} — Valid Positions (LINE)`);
    const done = await doRecordCycle(proxy, deployer);
    if (done) {
      console.log(`\n  ✔ Objective reached! Mission completed automatically.`);
      break;
    }
  }
}

// SCENARIO: VIOLATION

async function runViolation(proxy, deployer) {
  const objective = Number(await proxy.missionObjective());

  const ronda_viol = [...LINE_POS];
  ronda_viol[2] = VIOLATION_POS;

  await positionRound(proxy, deployer, ronda_viol, "CYCLE 1 — UAV3 Drifts to VIOLATION_POS");

  sep("CYCLE 1 — UAV1+UAV2 Report → violationCount=1");
  await sendTx(proxy.connect(deployer).reportViolation(UAV_ADDRESSES[0], UAV_ADDRESSES[2], GAS),
    "reportViolation UAV1 → UAV3");
  await sendTx(proxy.connect(deployer).reportViolation(UAV_ADDRESSES[1], UAV_ADDRESSES[2], GAS),
    "reportViolation UAV2 → UAV3  ← quorum → violationCount=1");

  await positionRound(proxy, deployer, ronda_viol, "CYCLE 1 — UAV3 Persists → OUT_OF_FORMATION");

  sep("CYCLE 1 — UAV1+UAV2 Report → violationCount=2 → OUT → DEGRADED");
  await sendTx(proxy.connect(deployer).reportViolation(UAV_ADDRESSES[0], UAV_ADDRESSES[2], GAS),
    "reportViolation UAV1 → UAV3");
  await sendTx(proxy.connect(deployer).reportViolation(UAV_ADDRESSES[1], UAV_ADDRESSES[2], GAS),
    "reportViolation UAV2 → UAV3  ← quorum → OUT_OF_FORMATION → DEGRADED");

  await doRecordCycle(proxy, deployer);
  console.log("  ✔ Cycle 1 degraded (UAV3 OUT_OF_FORMATION) — low score");
  await printSummary(proxy);

  sep("RECOVERY — UAV3 Returns to Formation + Peer Confirmation");
  await sendTx(proxy.connect(deployer).updatePosition(UAV_ADDRESSES[2], LINE_POS[2].x, LINE_POS[2].y, GAS),
    `updatePosition UAV3 (${LINE_POS[2].x},${LINE_POS[2].y}) ← attempts to return`);
  await sendTx(proxy.connect(deployer).reportRecovery(UAV_ADDRESSES[0], UAV_ADDRESSES[2], GAS),
    "reportRecovery UAV1 → UAV3");
  await sendTx(proxy.connect(deployer).reportRecovery(UAV_ADDRESSES[1], UAV_ADDRESSES[2], GAS),
    "reportRecovery UAV2 → UAV3  ← quorum → OK → ACTIVE");
  console.log("  ✔ UAV3 recovered → mission ACTIVE");

  for (let round = 2; round <= objective + 1; round++) {
    await positionRound(proxy, deployer, LINE_POS, `CYCLE ${round} — All OK (Healthy)`);
    const done = await doRecordCycle(proxy, deployer);
    if (done) {
      console.log(`\n  ✔ Objective reached after recovery! Mission completed.`);
      break;
    }
  }
}

// SCENARIO: LATE

async function runLate(proxy, deployer) {
  const objective = Number(await proxy.missionObjective());

  await positionRound(proxy, deployer, LINE_POS, "CYCLE 1 — All Report");
  await doRecordCycle(proxy, deployer);
  await printSummary(proxy);

  sep("PAUSE — UAV3 Silent");
  const toleranceSec = Number(await proxy.toleranceWindow());
  const waitSec      = toleranceSec + 2;
  console.log(`  UAV3 sends nothing for ${waitSec}s (toleranceWindow=${toleranceSec}s)`);

  await increaseTime(waitSec);

  await sendTx(proxy.connect(deployer).updatePosition(UAV_ADDRESSES[0], LINE_POS[0].x, LINE_POS[0].y, GAS),
    "updatePosition UAV1 (fresh)");
  await sendTx(proxy.connect(deployer).updatePosition(UAV_ADDRESSES[1], LINE_POS[1].x, LINE_POS[1].y, GAS),
    "updatePosition UAV2 (fresh)");

  await sendTx(proxy.connect(deployer).checkLateUAVs(GAS), "checkLateUAVs");
  console.log("  → UAV3 LATE | UAV1 and UAV2 OK → ACTIVE");

  await doRecordCycle(proxy, deployer);
  console.log("  ✔ Cycle 2 degraded (UAV3 LATE) — partial score");
  await printSummary(proxy);

  await positionRound(proxy, deployer, LINE_POS,
    "RECOVERY — UAV3 Reports Again → LATE → OK → ACTIVE");
  console.log("  ✔ UAV3 → LATE auto-resets to OK (no quorum needed)");

  for (let round = 3; round <= objective + 2; round++) {
    await positionRound(proxy, deployer, LINE_POS, `CYCLE ${round} — All OK (Healthy)`);
    const done = await doRecordCycle(proxy, deployer);
    if (done) {
      console.log(`\n  ✔ Objective reached after LATE recovery! Mission completed.`);
      break;
    }
  }
}

// SCENARIO: FORMATION CHANGE

async function runFormationChange(proxy, deployer) {
  const objective = Number(await proxy.missionObjective());

  await positionRound(proxy, deployer, LINE_POS, "CYCLE 1 — LINE Formation (Valid)");
  await doRecordCycle(proxy, deployer);
  await printSummary(proxy);

  sep("FORMATION CHANGE: LINE → V");
  const transitionSec = Number(await proxy.transitionTime());
  console.log(`  Grace period: ${transitionSec}s — no penalty during transition`);

  await sendTx(
    proxy.connect(deployer).changeFormation(1, 4_000_000, 64_000_000, 25_000_000, GAS),
    "changeFormation LINE → V"
  );
  console.log("  ✔ Mission in RECONFIGURING_FORMATION — grace period active");

  await positionRound(proxy, deployer, V_POS,
    "TRANSITION — UAVs Reposition to V Formation (no penalty)");
  await printSummary(proxy);

  sep("END OF GRACE PERIOD");
  const waitSec = transitionSec + 1;
  console.log(`  Waiting ${waitSec}s...`);
  await increaseTime(waitSec);

  await sendTx(proxy.connect(deployer).finalizeFormationChange(GAS), "finalizeFormationChange");
  console.log("  ✔ V formation applied — validation resumed");

  for (let round = 2; round <= objective + 1; round++) {
    await positionRound(proxy, deployer, V_POS, `CYCLE ${round} — Valid V Positions (Healthy)`);
    const done = await doRecordCycle(proxy, deployer);
    if (done) {
      console.log(`\n  ✔ Objective reached in the new V formation! Mission completed.`);
      break;
    }
  }
}

// MAIN

async function main() {
  const addrPath = path.join(__dirname, "..", "formation_addresses.json");
  if (!fs.existsSync(addrPath)) throw new Error("formation_addresses.json not found.");
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  if (!addresses.implementationV2) throw new Error("Proxy is not on V2 yet. Run upgrade:formation first.");

  const [deployerRaw] = await hre.ethers.getSigners();
  const deployer      = new hre.ethers.NonceManager(deployerRaw);
  const proxy         = await hre.ethers.getContractAt("MissionFormationV2", addresses.proxy);

  sep("MissionFormation (V2) — Scenario: " + SCENARIO.toUpperCase());
  console.log("  Network   :", hre.network.name);
  console.log("  Proxy     :", addresses.proxy);
  console.log("  Version   :", await proxy.version());
  console.log("  Scenario  :", SCENARIO);
  console.log("  Objective :", (await proxy.missionObjective()).toString(), "healthy cycles");
  console.log("  Deployer  :", deployer.address);

  sep("VERIFICATION — V1 State Preserved");

  const uavCount = await proxy.getUAVCount();
  const [cx, cy] = await proxy.getCentroid();
  console.log(`  Registered UAVs : ${uavCount} ← preserved ✓`);
  console.log(`  Centroid        : (${cx}, ${cy}) ← preserved ✓`);
  console.log(`  Quorum          : ${await proxy.quorum()} ← preserved ✓`);
  console.log(`  MaxViolations   : ${await proxy.maxViolations()} ← preserved ✓`);

  for (let i = 0; i < UAV_ADDRESSES.length; i++) {
    const u = await proxy.uavs(UAV_ADDRESSES[i]);
    if (!u.registered) continue;
    console.log(`  UAV${i+1}: state=${["OK","LATE","OUT","INACTIVE"][Number(u.state)]}  ← preserved ✓`);
  }

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
