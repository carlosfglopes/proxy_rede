// scripts/reset_recon_v1.js
// Full reset of the MissionRecon mission (V1) — clears all state
// (permitted/registered UAVs, leader, report) while keeping the same
// proxy.
//
// Usage:
//   npx hardhat run scripts/reset_recon_v1.js --network rede-proxy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const GAS = { gasLimit: 3_000_000 };
const ZONE = "Zone-Alpha";

async function main() {
  const addrPath = path.join(__dirname, "..", "recon_addresses.json");
  if (!fs.existsSync(addrPath)) throw new Error("recon_addresses.json not found.");
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  if (addresses.implementationV2) throw new Error("Proxy is already on V2 — use reset_recon.js instead.");

  const [deployer] = await hre.ethers.getSigners();
  const proxy      = await hre.ethers.getContractAt("MissionReconV1", addresses.proxy);

  console.log("=".repeat(60));
  console.log("  FULL RESET — MissionRecon (V1)");
  console.log("=".repeat(60));
  console.log(`  Proxy    : ${addresses.proxy}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Version  : ${await proxy.version()}`);
  console.log("-".repeat(60));

  const tx      = await proxy.connect(deployer).resetMission(ZONE, GAS);
  const receipt = await tx.wait();
  console.log(`  [resetMission] gas: ${receipt.gasUsed.toString()} | block: ${receipt.blockNumber}`);

  console.log("=".repeat(60));
  console.log("  RESET COMPLETE");
  console.log(`  State cleared — UAVs removed, new zone: ${ZONE}`);
  console.log("  Next step: npx hardhat run scripts/authority_recon.js --network rede-proxy");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n[ERROR]:", err.message);
  process.exit(1);
});
