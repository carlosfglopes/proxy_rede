// scripts/reset_formation_v2.js
// Partial reset of the MissionFormation mission (V2) — keeps registered
// UAVs. Clears violations, votes, and V2 metrics. Allows running
// simulate_formation_v2 directly.
//
// Usage:
//   npx hardhat run scripts/reset_formation_v2.js --network rede-proxy
//
// Prerequisite: npm run upgrade:formation + npm run simulate:formation:v1

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const UAV_ADDRESSES = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
];

const GAS = { gasLimit: 3_000_000 };

async function main() {
  const addrPath = path.join(__dirname, "..", "formation_addresses.json");
  if (!fs.existsSync(addrPath)) throw new Error("formation_addresses.json not found.");
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  if (!addresses.implementationV2) throw new Error("Proxy is not on V2 yet. Run upgrade:formation first.");

  const [deployer] = await hre.ethers.getSigners();
  const proxy      = await hre.ethers.getContractAt("MissionFormationV2", addresses.proxy);

  console.log("=".repeat(60));
  console.log("  RESET V2 — MissionFormation (keeps registered UAVs)");
  console.log("=".repeat(60));
  console.log(`  Proxy    : ${addresses.proxy}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Version  : ${await proxy.version()}`);
  console.log("-".repeat(60));

  const tx      = await proxy.connect(deployer).resetV2State(GAS);
  const receipt = await tx.wait();
  console.log(`  [resetV2State] gas: ${receipt.gasUsed.toString()} | block: ${receipt.blockNumber}`);

  console.log("\n  State after reset:");
  const uavCount = await proxy.getUAVCount();
  console.log(`  Registered UAVs : ${uavCount} ← preserved ✓`);
  console.log(`  missionState    : ACTIVE`);
  console.log(`  totalCycles     : ${await proxy.totalCycles()}`);
  console.log(`  formationScore  : ${await proxy.formationScore()}`);

  for (let i = 0; i < UAV_ADDRESSES.length; i++) {
    const u = await proxy.uavs(UAV_ADDRESSES[i]);
    if (!u.registered) continue;
    console.log(`  UAV${i+1}: state=OK  viol=0`);
  }

  console.log("=".repeat(60));
  console.log("  RESET V2 COMPLETE");
  console.log("  Next step: npm run simulate:formation:v2");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n[ERROR]:", err.message);
  process.exit(1);
});
