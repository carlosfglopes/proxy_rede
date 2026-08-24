// scripts/simulate_v2.js
// MissionFail scenario simulation with V2 logic.
//
// Usage:
//   npx hardhat run scripts/simulate_v2.js --network rede-proxy
//   $env:SCENARIO="heartbeat_fail"; npx hardhat run scripts/simulate_v2.js --network rede-proxy
//   $env:SCENARIO="battery_low";    npx hardhat run scripts/simulate_v2.js --network rede-proxy
//   $env:SCENARIO="abort";          npx hardhat run scripts/simulate_v2.js --network rede-proxy
//   $env:SCENARIO="reject";         npx hardhat run scripts/simulate_v2.js --network rede-proxy

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const SCENARIO = process.env.SCENARIO || "heartbeat_fail";

const GAS = { gasLimit: 3_000_000 };

function sep(label) {
  console.log(`\n${"─".repeat(50)}`);
  if (label) console.log(`  ${label}`);
  console.log("─".repeat(50));
}

async function sendTx(promise, label) {
  const tx = await promise;
  const receipt = await tx.wait();
  console.log(
    `  [${label}] gas: ${receipt.gasUsed.toString()} | block: ${receipt.blockNumber}`,
  );
  return receipt;
}

async function printSummary(proxy) {
  const count = await proxy.uavCount();
  const report = await proxy.getMissionReport();

  console.log("\n  ── Mission State ─────────────────────────");
  console.log("  State       :", report.active ? "ACTIVE" : "FINISHED");
  console.log("  Score       :", report.score.toString() + "/100");
  console.log("  Faults      :", report.faultedCount.toString());
  console.log("  Operational :", report.operationalCount.toString());
  console.log("  Total UAVs  :", report.totalUAVs.toString());

  console.log("\n  ── UAV State ─────────────────────────────");
  for (let i = 1n; i <= count; i++) {
    const u = await proxy.getUAV(i);
    const [faults, task] = await proxy.getUAVReport(i);
    console.log(
      `  UAV${i} (${u.role.padEnd(8)})  state=${u.operational ? "ACTIVE  " : "FAILED  "}` +
        `  bat=${String(u.batteryLevel).padStart(3)}%  task=${task}  faults=${faults}`,
    );
  }
}

async function setup(proxy, deployer) {
  sep("SETUP — Reset + Task Assignment (V2)");

  await sendTx(
    proxy.connect(deployer).resetV2State(GAS),
    "resetV2State ← restores state for a new simulation",
  );

  await sendTx(
    proxy.connect(deployer).assignTask(1, 101, GAS),
    "assignTask UAV1 → T101",
  );
  await sendTx(
    proxy.connect(deployer).assignTask(2, 102, GAS),
    "assignTask UAV2 → T102",
  );
  await sendTx(
    proxy.connect(deployer).assignTask(3, 103, GAS),
    "assignTask UAV3 → T103",
  );

  const count = await proxy.uavCount();
  for (let i = 1n; i <= count; i++) {
    const [, task] = await proxy.getUAVReport(i);
    const u = await proxy.getUAV(i);
    console.log(
      `  ✔ UAV${i} (${u.role}): task ${task} | bat=${u.batteryLevel}%`,
    );
  }
}

async function runHeartbeatFail(proxy, deployer) {
  sep("SCENARIO: HEARTBEAT FAIL — UAV1");

  await sendTx(
    proxy.connect(deployer).logEvent(1, "search_started", GAS),
    "logEvent UAV1",
  );
  await sendTx(
    proxy.connect(deployer).logEvent(2, "patrol_zone_B", GAS),
    "logEvent UAV2",
  );
  await sendTx(
    proxy.connect(deployer).logEvent(3, "monitoring_active", GAS),
    "logEvent UAV3",
  );

  sep("HEARTBEAT LOST — UAV1 not responding");
  await sendTx(
    proxy.connect(deployer).logEvent(1, "heartbeat_timeout", GAS),
    "logEvent UAV1 ← last heartbeat",
  );
  await sendTx(
    proxy.connect(deployer).reportFault(1, GAS),
    "reportFault UAV1 → FAILED",
  );

  const u1 = await proxy.getUAV(1);
  console.log(
    `  UAV1 after failure: state=${u1.operational ? "ACTIVE" : "FAILED"}`,
  );
  console.log("  ✔ UAV1 marked FAILED — missing heartbeat detected");

  sep("REDISTRIBUTION — T101: UAV1 → UAV3");
  await sendTx(
    proxy.connect(deployer).redistributeTask(1, 3, GAS),
    "redistributeTask T101: UAV1 → UAV3",
  );

  const [, task1After] = await proxy.getUAVReport(1);
  const [, task3After] = await proxy.getUAVReport(3);
  console.log(`  UAV1 task: ${task1After} (released)`);
  console.log(`  UAV3 task: ${task3After} (took over T101)`);

  sep("MISSION CONTINUES WITH UAV2 AND UAV3");
  await sendTx(
    proxy.connect(deployer).updateBattery(2, 68, GAS),
    "updateBattery UAV2 → 68%",
  );
  await sendTx(
    proxy.connect(deployer).updateBattery(3, 82, GAS),
    "updateBattery UAV3 → 82%",
  );
  await sendTx(
    proxy.connect(deployer).logEvent(2, "patrol_extended", GAS),
    "logEvent UAV2 (extends patrol)",
  );
  await sendTx(
    proxy.connect(deployer).logEvent(3, "recon_role_assumed", GAS),
    "logEvent UAV3 (takes on T101 + T103)",
  );
  await sendTx(
    proxy.connect(deployer).setMissionScore(70, GAS),
    "setMissionScore(70)",
  );
  await sendTx(
    proxy.connect(deployer).setMissionActive(false, GAS),
    "setMissionActive(false)",
  );

  console.log(
    "  ✔ Mission completed with 1 failure from heartbeat timeout — score: 70/100",
  );
}

async function runBatteryLow(proxy, deployer) {
  sep("SCENARIO: CRITICAL BATTERY — UAV2");

  await sendTx(
    proxy.connect(deployer).logEvent(1, "search_started", GAS),
    "logEvent UAV1",
  );
  await sendTx(
    proxy.connect(deployer).logEvent(2, "patrol_zone_B", GAS),
    "logEvent UAV2",
  );
  await sendTx(
    proxy.connect(deployer).logEvent(3, "monitoring_active", GAS),
    "logEvent UAV3",
  );

  await sendTx(
    proxy.connect(deployer).updateBattery(1, 72, GAS),
    "updateBattery UAV1 → 72%",
  );
  await sendTx(
    proxy.connect(deployer).updateBattery(3, 80, GAS),
    "updateBattery UAV3 → 80%",
  );

  sep("CRITICAL BATTERY — UAV2 drops to 15%");
  await sendTx(
    proxy.connect(deployer).updateBattery(2, 15, GAS),
    "updateBattery UAV2 → 15% ← CRITICAL",
  );
  await sendTx(
    proxy.connect(deployer).logEvent(2, "low_battery_critical", GAS),
    "logEvent UAV2",
  );
  await sendTx(
    proxy.connect(deployer).reportFault(2, GAS),
    "reportFault UAV2 → FAILED",
  );

  const u2 = await proxy.getUAV(2);
  console.log(
    `  UAV2 after failure: state=${u2.operational ? "ACTIVE" : "FAILED"} | bat=${u2.batteryLevel}%`,
  );

  sep("REDISTRIBUTION — T102: UAV2 → UAV3");
  await sendTx(
    proxy.connect(deployer).redistributeTask(2, 3, GAS),
    "redistributeTask T102: UAV2 → UAV3",
  );

  const [, task2After] = await proxy.getUAVReport(2);
  const [, task3After] = await proxy.getUAVReport(3);
  console.log(`  UAV2 task: ${task2After} (released)`);
  console.log(`  UAV3 task: ${task3After} (took over T102)`);

  sep("MISSION CONTINUES WITH UAV1 AND UAV3");
  await sendTx(
    proxy.connect(deployer).logEvent(1, "coverage_extended", GAS),
    "logEvent UAV1 (covers UAV2 area)",
  );
  await sendTx(
    proxy.connect(deployer).logEvent(3, "zone_B_assumed", GAS),
    "logEvent UAV3 (assumes zone B)",
  );
  await sendTx(
    proxy.connect(deployer).setMissionScore(68, GAS),
    "setMissionScore(68)",
  );
  await sendTx(
    proxy.connect(deployer).setMissionActive(false, GAS),
    "setMissionActive(false)",
  );

  console.log(
    "  ✔ Mission completed with 1 failure from critical battery — score: 68/100",
  );
}

async function runAbort(proxy, deployer) {
  sep("SCENARIO: ABORT — CASCADING MULTIPLE FAILURES");

  await sendTx(
    proxy.connect(deployer).logEvent(1, "search_started", GAS),
    "logEvent UAV1",
  );
  await sendTx(
    proxy.connect(deployer).logEvent(2, "patrol_zone_B", GAS),
    "logEvent UAV2",
  );
  await sendTx(
    proxy.connect(deployer).logEvent(3, "monitoring_active", GAS),
    "logEvent UAV3",
  );

  sep("FAILURE 1 — UAV2 motor failure");
  await sendTx(
    proxy.connect(deployer).logEvent(2, "motor_failure_detected", GAS),
    "logEvent UAV2",
  );
  await sendTx(
    proxy.connect(deployer).reportFault(2, GAS),
    "reportFault UAV2 → FAILED",
  );
  console.log("  ✔ UAV2 marked FAILED");

  await sendTx(
    proxy.connect(deployer).redistributeTask(2, 3, GAS),
    "redistributeTask T102: UAV2 → UAV3",
  );
  console.log("  ✔ T102 redistributed to UAV3 — mission tries to continue");

  sep("FAILURE 2 — UAV3 collapses under double load");
  await sendTx(
    proxy.connect(deployer).updateBattery(3, 6, GAS),
    "updateBattery UAV3 → 6% ← CRITICAL",
  );
  await sendTx(
    proxy.connect(deployer).logEvent(3, "overload_power_failure", GAS),
    "logEvent UAV3 ← overload failure",
  );
  await sendTx(
    proxy.connect(deployer).reportFault(3, GAS),
    "reportFault UAV3 → FAILED",
  );
  console.log(
    "  ✔ UAV3 marked FAILED — no UAVs available to redistribute to",
  );

  sep("ABORT — NO OPERATIONAL UAVs FOR T102 AND T103");
  const [faults1, task1] = await proxy.getUAVReport(1);
  const [faults2, task2] = await proxy.getUAVReport(2);
  const [faults3, task3] = await proxy.getUAVReport(3);
  console.log(
    `  UAV1: task=${task1} | faults=${faults1} (operational, only T101)`,
  );
  console.log(`  UAV2: task=${task2} | faults=${faults2} (FAILED)`);
  console.log(
    `  UAV3: task=${task3} | faults=${faults3} (FAILED — in cascade)`,
  );
  console.log("  ✖ T102 and T103 uncovered — failure threshold reached");

  await sendTx(
    proxy.connect(deployer).logEvent(1, "mission_abort_alert", GAS),
    "logEvent UAV1 (abort alert)",
  );
  await sendTx(
    proxy.connect(deployer).setMissionScore(15, GAS),
    "setMissionScore(15) ← ABORT",
  );
  await sendTx(
    proxy.connect(deployer).setMissionActive(false, GAS),
    "setMissionActive(false)",
  );

  console.log(
    "  ✔ Mission aborted due to cascading failures — critical score: 15/100",
  );
  console.log(
    "  ✔ Demonstrates the limit of the V2 mechanism: with no UAVs available, abort is inevitable",
  );
}

async function runReject(proxy, deployer) {
  sep("SCENARIO: REJECT — FALSE ALARM UAV2");

  await sendTx(
    proxy.connect(deployer).logEvent(1, "search_started", GAS),
    "logEvent UAV1",
  );
  await sendTx(
    proxy.connect(deployer).logEvent(2, "patrol_zone_B", GAS),
    "logEvent UAV2",
  );
  await sendTx(
    proxy.connect(deployer).logEvent(3, "monitoring_active", GAS),
    "logEvent UAV3",
  );

  sep("FALSE ALARM — UAV2 incorrectly reported");
  await sendTx(
    proxy.connect(deployer).logEvent(2, "signal_glitch_false_alarm", GAS),
    "logEvent UAV2 ← momentary signal glitch",
  );
  await sendTx(
    proxy.connect(deployer).reportFault(2, GAS),
    "reportFault UAV2 → FAILED (false alarm)",
  );

  const u2_after_fault = await proxy.getUAV(2);
  console.log(
    `  UAV2 after report: state=${u2_after_fault.operational ? "ACTIVE" : "FAILED"}`,
  );
  console.log("  Authority investigates the incident...");

  sep("REJECT — UAV2 confirmed operational (false detection)");
  await sendTx(
    proxy.connect(deployer).updateBattery(2, 74, GAS),
    "updateBattery UAV2 → 74% (normal battery)",
  );
  await sendTx(
    proxy.connect(deployer).setUAVOperational(2, true, GAS),
    "setUAVOperational UAV2 → ACTIVE (failure rejected)",
  );
  await sendTx(
    proxy.connect(deployer).logEvent(2, "false_alarm_cleared", GAS),
    "logEvent UAV2 ← reintegrated",
  );

  const u2_restored = await proxy.getUAV(2);
  console.log(
    `  UAV2 restored: state=${u2_restored.operational ? "ACTIVE" : "FAILED"}`,
  );
  console.log("  ✔ False alarm rejected — UAV2 reintegrated into the mission");

  sep("MISSION CONTINUES WITH ALL UAVs");
  await sendTx(
    proxy.connect(deployer).updateBattery(1, 65, GAS),
    "updateBattery UAV1 → 65%",
  );
  await sendTx(
    proxy.connect(deployer).updateBattery(3, 77, GAS),
    "updateBattery UAV3 → 77%",
  );
  await sendTx(
    proxy.connect(deployer).logEvent(1, "search_continuing", GAS),
    "logEvent UAV1",
  );
  await sendTx(
    proxy.connect(deployer).logEvent(2, "patrol_resumed", GAS),
    "logEvent UAV2 (resumes patrol)",
  );
  await sendTx(
    proxy.connect(deployer).logEvent(3, "monitoring_active", GAS),
    "logEvent UAV3",
  );
  await sendTx(
    proxy.connect(deployer).setMissionScore(88, GAS),
    "setMissionScore(88)",
  );
  await sendTx(
    proxy.connect(deployer).setMissionActive(false, GAS),
    "setMissionActive(false)",
  );

  console.log("  ✔ Mission completed with no real losses — score: 88/100");
  console.log(
    "  ✔ Demonstrates that the V2 mechanism allows reverting false alarms via setUAVOperational",
  );
}

async function main() {
  const addrPath = path.join(__dirname, "..", "proxy_addresses.json");
  if (!fs.existsSync(addrPath))
    throw new Error("proxy_addresses.json not found.");
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));

  if (!addresses.implementationV2) {
    throw new Error(
      "Proxy is not on V2 yet. Run upgrade_proxy.js first.",
    );
  }

  const [deployer] = await hre.ethers.getSigners();
  const proxy = await hre.ethers.getContractAt(
    "MissionFailV2",
    addresses.proxy,
  );

  sep("MissionFail (V2) — Scenario: " + SCENARIO.toUpperCase());
  console.log("  Network   :", hre.network.name);
  console.log("  Proxy     :", addresses.proxy);
  console.log("  Version   :", await proxy.version());
  console.log("  Scenario  :", SCENARIO);
  console.log("  Deployer  :", deployer.address);

  await setup(proxy, deployer);

  if (SCENARIO === "heartbeat_fail") await runHeartbeatFail(proxy, deployer);
  else if (SCENARIO === "battery_low") await runBatteryLow(proxy, deployer);
  else if (SCENARIO === "abort") await runAbort(proxy, deployer);
  else if (SCENARIO === "reject") await runReject(proxy, deployer);
  else
    throw new Error(
      `Invalid scenario: "${SCENARIO}". Use: heartbeat_fail | battery_low | abort | reject`,
    );

  sep("FINAL RESULT");
  await printSummary(proxy);

  sep("END");
}

main().catch((err) => {
  console.error("✘ Error:", err.message);
  process.exitCode = 1;
});
