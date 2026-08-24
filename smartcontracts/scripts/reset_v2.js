// scripts/reset_v2.js
// Partial reset — clears V2 state but keeps UAVs and the mission. Allows
// running simulate_v2 directly without running simulate_v1.
//
// Usage:
//   npx hardhat run scripts/reset_v2.js --network rede-proxy

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const GAS = { gasLimit: 3_000_000 };

async function main() {
  const addrPath = path.join(__dirname, "..", "proxy_addresses.json");
  if (!fs.existsSync(addrPath))
    throw new Error("proxy_addresses.json not found.");
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  if (!addresses.implementationV2)
    throw new Error("Proxy is not on V2 yet.");

  const [deployer] = await hre.ethers.getSigners();
  const proxy = await hre.ethers.getContractAt(
    "MissionFailV2",
    addresses.proxy,
  );

  console.log("=".repeat(60));
  console.log("  RESET V2 — Clearing V2 state (UAVs kept)");
  console.log("=".repeat(60));
  console.log(`  Proxy    : ${addresses.proxy}`);
  console.log(`  UAVs     : ${await proxy.uavCount()} (kept)`);

  const tx = await proxy.connect(deployer).resetV2State(GAS);
  await tx.wait();

  const count = await proxy.uavCount();
  console.log("\n  ✓ V2 state cleared — UAVs remain registered:");
  for (let i = 1n; i <= count; i++) {
    const u = await proxy.getUAV(i);
    const [faults, task] = await proxy.getUAVReport(i);
    console.log(
      `    UAV ${i}: ${u.role.padEnd(10)} | op=${u.operational} | faults=${faults} | task=${task}`,
    );
  }
  console.log(`\n  Mission active : ${await proxy.missionActive()}`);
  console.log(`  Score          : ${await proxy.missionScore()}`);
  console.log("=".repeat(60));
  console.log("  Ready — run simulate_v2 directly.");
  console.log("  Next step: npm run simulate:v2");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n[ERROR]:", err.message);
  process.exitCode = 1;
});
