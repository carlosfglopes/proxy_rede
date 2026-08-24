// scripts/reset_mission.js
// Clears the proxy state to allow running a new mission without
// redeploying. Works on both V1 and V2.
//
// Usage:
//   npx hardhat run scripts/reset_mission.js --network rede-proxy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const GAS = { gasLimit: 3_000_000 };

async function main() {
  const addrPath = path.join(__dirname, "..", "proxy_addresses.json");
  if (!fs.existsSync(addrPath)) throw new Error("proxy_addresses.json not found.");

  const addresses  = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  const [deployer] = await hre.ethers.getSigners();

  const proxy   = await hre.ethers.getContractAt("MissionFailV1", addresses.proxy);
  const version = await proxy.version();

  console.log("=".repeat(60));
  console.log("  RESET — Clearing proxy state");
  console.log("=".repeat(60));
  console.log(`  Proxy   : ${addresses.proxy}`);
  console.log(`  Version : ${version}`);
  console.log(`  UAVs before reset: ${await proxy.getUAVCount()}`);

  const tx = await proxy.connect(deployer).resetMission(GAS);
  await tx.wait();

  console.log(`\n  ✓ Reset complete`);
  console.log(`  UAVs after reset : ${await proxy.getUAVCount()}`);
  console.log(`  missionActive()  : ${await proxy.missionActive()} (false = SETUP ✓)`);
  console.log("=".repeat(60));
  console.log("  Proxy clean — ready for a new simulation.");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n[ERROR]:", err.message);
  process.exitCode = 1;
});
