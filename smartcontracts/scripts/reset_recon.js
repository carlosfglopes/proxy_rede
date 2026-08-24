// scripts/reset_recon.js
// Full reset of the MissionRecon mission (V2) — clears all state.
//
// Usage:
//   npx hardhat run scripts/reset_recon.js --network rede-proxy
//
// Prerequisite: npm run upgrade:recon

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const GAS = { gasLimit: 3_000_000 };

async function main() {
  const addrPath = path.join(__dirname, "..", "recon_addresses.json");
  if (!fs.existsSync(addrPath)) throw new Error("recon_addresses.json not found.");
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  if (!addresses.implementationV2) throw new Error("Proxy is not on V2 yet. Run upgrade:recon first.");

  const [deployer] = await hre.ethers.getSigners();
  const proxy      = await hre.ethers.getContractAt("MissionReconV2", addresses.proxy);

  console.log("=".repeat(60));
  console.log("  FULL RESET — MissionRecon (V2)");
  console.log("=".repeat(60));
  console.log(`  Proxy    : ${addresses.proxy}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Version  : ${await proxy.version()}`);
  console.log("-".repeat(60));

  const tx      = await proxy.connect(deployer).resetMission("Zone-Alpha", GAS);
  const receipt = await tx.wait();
  console.log(`  [resetMission] gas: ${receipt.gasUsed.toString()} | block: ${receipt.blockNumber}`);

  console.log("=".repeat(60));
  console.log("  RESET COMPLETE");
  console.log("  State cleared — UAVs removed, new zone: Zone-Alpha");
  console.log("  Next step: npm run simulate:recon:v1");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n[ERROR]:", err.message);
  process.exit(1);
});
