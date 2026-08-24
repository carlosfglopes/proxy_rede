// scripts/reset_formation.js
// Full reset of the MissionFormation mission — clears all state. Works
// on both V1 and V2.
//
// Usage:
//   npx hardhat run scripts/reset_formation.js --network rede-proxy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const GAS = { gasLimit: 3_000_000 };

async function main() {
  const addrPath = path.join(__dirname, "..", "formation_addresses.json");
  if (!fs.existsSync(addrPath)) throw new Error("formation_addresses.json not found.");
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));

  const [deployer] = await hre.ethers.getSigners();

  const proxy   = await hre.ethers.getContractAt("MissionFormationV1", addresses.proxy);
  const version = await proxy.version();

  console.log("=".repeat(60));
  console.log("  FULL RESET — MissionFormation");
  console.log("=".repeat(60));
  console.log(`  Proxy    : ${addresses.proxy}`);
  console.log(`  Version  : ${version}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log("-".repeat(60));

  const tx      = await proxy.connect(deployer).resetMission(GAS);
  const receipt = await tx.wait();
  console.log(`  [resetMission] gas: ${receipt.gasUsed.toString()} | block: ${receipt.blockNumber}`);

  console.log("=".repeat(60));
  console.log("  RESET COMPLETE");
  console.log("  State cleared — UAVs removed, missionActive=false (SETUP)");
  console.log("  Next step: simulate:formation:v1");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n[ERROR]:", err.message);
  process.exit(1);
});
