// scripts/simulate_v1.js
// MissionFail scenario simulation with V1 logic.
//
// Usage:
//   npx hardhat run scripts/simulate_v1.js --network rede-proxy
//   $env:SCENARIO="heartbeat_fail"; npx hardhat run scripts/simulate_v1.js --network rede-proxy
//   $env:SCENARIO="battery_low";    npx hardhat run scripts/simulate_v1.js --network rede-proxy
//   $env:SCENARIO="abort";          npx hardhat run scripts/simulate_v1.js --network rede-proxy
//   $env:SCENARIO="reject";         npx hardhat run scripts/simulate_v1.js --network rede-proxy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const SCENARIO = process.env.SCENARIO || "heartbeat_fail";

const UAV_PROFILES = [
  { role: "recon",    battery: 90 },
  { role: "response", battery: 75 },
  { role: "monitor",  battery: 85 },
];

const UAV_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];

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

async function printSummary(proxy) {
  const [name, , total, active] = await proxy.getMissionInfo();
  console.log("\n  ── Mission State ─────────────────────────");
  console.log("  State      :", active ? "ACTIVE" : "INACTIVE");
  console.log("  Mission    :", name);
  console.log("  Version    :", await proxy.version());
  console.log("  Total UAVs :", total.toString());

  console.log("\n  ── UAV State ─────────────────────────────");
  for (let i = 1n; i <= total; i++) {
    const u = await proxy.getUAV(i);
    console.log(
      `  UAV${i} (${u.role.padEnd(8)})  state=${u.operational ? "ACTIVE  " : "INACTIVE"}` +
      `  bat=${String(u.batteryLevel).padStart(3)}%  event="${u.lastEvent}"`
    );
  }
}

async function setup(proxy, deployer, uavSigners) {
  sep("SETUP — Register UAVs + Start Mission");

  await sendTx(proxy.connect(deployer).setMissionActive(true, GAS), "setMissionActive");

  for (let i = 0; i < UAV_PROFILES.length; i++) {
    const p = UAV_PROFILES[i];
    await sendTx(
      proxy.connect(deployer).registerUAV(uavSigners[i].address, p.role, GAS),
      `registerUAV UAV${i+1} (${p.role})`
    );
    await sendTx(proxy.connect(deployer).updateBattery(i+1, p.battery, GAS), `updateBattery UAV${i+1}`);
    console.log(`  ✔ UAV${i+1}: ${uavSigners[i].address} (${p.role}) | bat=${p.battery}%`);
  }
}

// SCENARIOS

async function runHeartbeatFail(proxy, deployer) {
  sep("SCENARIO: HEARTBEAT FAIL — UAV1");

  await sendTx(proxy.connect(deployer).logEvent(1, "search_started",    GAS), "logEvent UAV1");
  await sendTx(proxy.connect(deployer).logEvent(2, "patrol_zone_B",     GAS), "logEvent UAV2");
  await sendTx(proxy.connect(deployer).logEvent(3, "monitoring_active", GAS), "logEvent UAV3");

  sep("HEARTBEAT LOST — UAV1 not responding");
  await sendTx(proxy.connect(deployer).logEvent(1, "heartbeat_timeout",  GAS), "logEvent UAV1 ← last heartbeat");
  await sendTx(proxy.connect(deployer).setUAVOperational(1, false, GAS),        "setUAVOperational UAV1 → INACTIVE");
  console.log("  ✔ UAV1 marked INACTIVE — missing heartbeat detected");

  sep("MISSION CONTINUES WITH UAV2 AND UAV3");
  await sendTx(proxy.connect(deployer).updateBattery(2, 68, GAS),             "updateBattery UAV2 → 68%");
  await sendTx(proxy.connect(deployer).updateBattery(3, 82, GAS),             "updateBattery UAV3 → 82%");
  await sendTx(proxy.connect(deployer).logEvent(2, "patrol_extended",    GAS), "logEvent UAV2 (extends patrol)");
  await sendTx(proxy.connect(deployer).logEvent(3, "recon_role_assumed", GAS), "logEvent UAV3 (assumes recon)");
  console.log("  ✔ UAV2 and UAV3 redistribute coverage — mission continues");
}

async function runBatteryLow(proxy, deployer) {
  sep("SCENARIO: CRITICAL BATTERY — UAV2");

  await sendTx(proxy.connect(deployer).logEvent(1, "search_started",    GAS), "logEvent UAV1");
  await sendTx(proxy.connect(deployer).logEvent(2, "patrol_zone_B",     GAS), "logEvent UAV2");
  await sendTx(proxy.connect(deployer).logEvent(3, "monitoring_active", GAS), "logEvent UAV3");

  await sendTx(proxy.connect(deployer).updateBattery(1, 72, GAS), "updateBattery UAV1 → 72%");
  await sendTx(proxy.connect(deployer).updateBattery(3, 80, GAS), "updateBattery UAV3 → 80%");

  sep("CRITICAL BATTERY — UAV2 drops to 15%");
  await sendTx(proxy.connect(deployer).updateBattery(2, 15, GAS),               "updateBattery UAV2 → 15% ← CRITICAL");
  await sendTx(proxy.connect(deployer).logEvent(2, "low_battery_critical", GAS), "logEvent UAV2");
  await sendTx(proxy.connect(deployer).setUAVOperational(2, false, GAS),         "setUAVOperational UAV2 → INACTIVE");
  console.log("  ✔ UAV2 marked INACTIVE due to critical battery");

  sep("MISSION CONTINUES WITH UAV1 AND UAV3");
  await sendTx(proxy.connect(deployer).logEvent(1, "coverage_extended", GAS), "logEvent UAV1 (covers UAV2 area)");
  await sendTx(proxy.connect(deployer).logEvent(3, "zone_B_assumed",    GAS), "logEvent UAV3 (assumes zone B)");
  console.log("  ✔ UAV1 and UAV3 redistribute coverage — mission continues");
}

async function runAbort(proxy, deployer) {
  sep("SCENARIO: ABORT — CASCADING MULTIPLE FAILURES");

  await sendTx(proxy.connect(deployer).logEvent(1, "search_started",    GAS), "logEvent UAV1");
  await sendTx(proxy.connect(deployer).logEvent(2, "patrol_zone_B",     GAS), "logEvent UAV2");
  await sendTx(proxy.connect(deployer).logEvent(3, "monitoring_active", GAS), "logEvent UAV3");

  sep("FAILURE 1 — UAV2 motor failure");
  await sendTx(proxy.connect(deployer).logEvent(2, "motor_failure_detected", GAS), "logEvent UAV2");
  await sendTx(proxy.connect(deployer).setUAVOperational(2, false, GAS),            "setUAVOperational UAV2 → INACTIVE");
  console.log("  ✔ UAV2 marked INACTIVE");

  sep("FAILURE 2 — UAV3 collapses under double load");
  await sendTx(proxy.connect(deployer).updateBattery(3, 6, GAS),                  "updateBattery UAV3 → 6% ← CRITICAL");
  await sendTx(proxy.connect(deployer).logEvent(3, "overload_power_failure", GAS),  "logEvent UAV3 ← overload failure");
  await sendTx(proxy.connect(deployer).setUAVOperational(3, false, GAS),            "setUAVOperational UAV3 → INACTIVE");
  console.log("  ✔ UAV3 marked INACTIVE — not enough UAVs to continue");

  sep("ABORT — FAILURE THRESHOLD REACHED");
  await sendTx(proxy.connect(deployer).logEvent(1, "mission_abort_alert", GAS), "logEvent UAV1 (abort alert)");
  await sendTx(proxy.connect(deployer).setMissionActive(false, GAS),             "setMissionActive(false) ← ABORTED");
  console.log("  ✔ Mission aborted due to cascading failures — only UAV1 operational");
  console.log("  ✔ V1 has no scoring or redistribution — demonstrates the limitation of this version");
}

async function runReject(proxy, deployer) {
  sep("SCENARIO: REJECT — FALSE ALARM UAV2");

  await sendTx(proxy.connect(deployer).logEvent(1, "search_started",    GAS), "logEvent UAV1");
  await sendTx(proxy.connect(deployer).logEvent(2, "patrol_zone_B",     GAS), "logEvent UAV2");
  await sendTx(proxy.connect(deployer).logEvent(3, "monitoring_active", GAS), "logEvent UAV3");

  sep("FALSE ALARM — UAV2 incorrectly reported");
  await sendTx(proxy.connect(deployer).logEvent(2, "signal_glitch_false_alarm", GAS), "logEvent UAV2 ← momentary signal glitch");
  await sendTx(proxy.connect(deployer).setUAVOperational(2, false, GAS),               "setUAVOperational UAV2 → INACTIVE (false alarm)");
  console.log("  Authority investigates the incident...");

  sep("REJECT — UAV2 confirmed operational (false detection)");
  await sendTx(proxy.connect(deployer).updateBattery(2, 74, GAS),               "updateBattery UAV2 → 74% (normal battery)");
  await sendTx(proxy.connect(deployer).setUAVOperational(2, true, GAS),          "setUAVOperational UAV2 → ACTIVE (failure rejected)");
  await sendTx(proxy.connect(deployer).logEvent(2, "false_alarm_cleared", GAS),  "logEvent UAV2 ← reintegrated");
  console.log("  ✔ False alarm rejected — UAV2 reintegrated into the mission");

  sep("MISSION CONTINUES WITH ALL UAVs");
  await sendTx(proxy.connect(deployer).updateBattery(1, 65, GAS),             "updateBattery UAV1 → 65%");
  await sendTx(proxy.connect(deployer).updateBattery(3, 77, GAS),             "updateBattery UAV3 → 77%");
  await sendTx(proxy.connect(deployer).logEvent(1, "search_continuing", GAS),  "logEvent UAV1");
  await sendTx(proxy.connect(deployer).logEvent(2, "patrol_resumed",    GAS),  "logEvent UAV2 (resumes patrol)");
  await sendTx(proxy.connect(deployer).logEvent(3, "monitoring_active", GAS),  "logEvent UAV3");
  console.log("  ✔ Mission continues with no real losses — all UAVs operational");
}

// MAIN

async function main() {
  const addrPath = path.join(__dirname, "..", "proxy_addresses.json");
  if (!fs.existsSync(addrPath)) throw new Error("proxy_addresses.json not found. Run deploy first.");

  const addresses  = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  const [deployer] = await hre.ethers.getSigners();
  const uavSigners = UAV_KEYS.map(k => new hre.ethers.Wallet(k, hre.ethers.provider));
  const proxy      = await hre.ethers.getContractAt("MissionFailV1", addresses.proxy);

  sep("MissionFail (V1) — Scenario: " + SCENARIO.toUpperCase());
  console.log("  Network   :", hre.network.name);
  console.log("  Proxy     :", addresses.proxy);
  console.log("  Version   :", await proxy.version());
  console.log("  Scenario  :", SCENARIO);
  console.log("  Deployer  :", deployer.address);
  uavSigners.forEach((s, i) => console.log(`  UAV${i+1}      : ${s.address}`));

  await setup(proxy, deployer, uavSigners);

  if      (SCENARIO === "heartbeat_fail") await runHeartbeatFail(proxy, deployer);
  else if (SCENARIO === "battery_low")    await runBatteryLow(proxy, deployer);
  else if (SCENARIO === "abort")          await runAbort(proxy, deployer);
  else if (SCENARIO === "reject")         await runReject(proxy, deployer);
  else throw new Error(`Invalid scenario: "${SCENARIO}". Use: heartbeat_fail | battery_low | abort | reject`);

  sep("FINAL RESULT");
  await printSummary(proxy);

  sep("END");
}

main().catch((err) => {
  console.error("✘ Error:", err.message);
  process.exitCode = 1;
});
