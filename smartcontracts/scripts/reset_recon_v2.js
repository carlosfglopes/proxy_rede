// scripts/reset_recon_v2.js
// Partial reset of the MissionRecon mission (V2) — keeps registered UAVs.
// Allows running simulate_recon_v2 directly without repeating the V1
// setup.
//
// Usage:
//   npx hardhat run scripts/reset_recon_v2.js --network rede-proxy
//
// Prerequisite: npm run upgrade:recon + npm run simulate:recon:v1

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const GAS = { gasLimit: 3_000_000 };

const UAV_ADDRESSES = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
];

async function main() {
  const addrPath = path.join(__dirname, "..", "recon_addresses.json");
  if (!fs.existsSync(addrPath)) throw new Error("recon_addresses.json not found.");
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  if (!addresses.implementationV2) throw new Error("Proxy is not on V2 yet. Run upgrade:recon first.");

  const [deployer] = await hre.ethers.getSigners();
  const proxy      = await hre.ethers.getContractAt("MissionReconV2", addresses.proxy);

  console.log("=".repeat(60));
  console.log("  RESET V2 — MissionRecon (keeps registered UAVs)");
  console.log("=".repeat(60));
  console.log(`  Proxy    : ${addresses.proxy}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Version  : ${await proxy.version()}`);
  console.log("-".repeat(60));

  const tx      = await proxy.connect(deployer).resetV2State(GAS);
  const receipt = await tx.wait();
  console.log(`  [resetV2State] gas: ${receipt.gasUsed.toString()} | block: ${receipt.blockNumber}`);

  console.log("\n  State after reset:");
  const uavCount = await proxy.getRegisteredUAVCount();
  const leader   = await proxy.electedLeader();
  console.log(`  Registered UAVs : ${uavCount} ← preserved ✓`);
  console.log(`  Leader          : ${leader === "0x0000000000000000000000000000000000000000" ? "none (cleared)" : leader}`);
  console.log(`  reportPending   : ${await proxy.reportPending()}`);
  console.log(`  confirmations   : ${await proxy.confirmationCount()}`);

  for (let i = 0; i < UAV_ADDRESSES.length; i++) {
    const u = await proxy.uavs(UAV_ADDRESSES[i]);
    if (!u.registered) continue;
    console.log(`  UAV${i+1}: score=${u.score}  hasVoted=${await proxy.hasVoted(UAV_ADDRESSES[i])}`);
  }

  console.log("=".repeat(60));
  console.log("  RESET V2 COMPLETE");
  console.log("  Next step: npm run simulate:recon:v2");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n[ERROR]:", err.message);
  process.exit(1);
});
