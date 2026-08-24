// scripts/upgrade_proxy.js
// Upgrades MissionFailV1 → MissionFailV2 (adds missionScore, small by
// design — used to measure the real cost of a UUPS upgrade).
//
// Usage:
//   npx hardhat run scripts/upgrade_proxy.js --network rede-proxy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { trackAuthorityTx, finishAndSaveMetrics } = require("./lib/metrics");

const GAS = { gasLimit: 3_000_000 };

// MAIN

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const fromBlock = await hre.ethers.provider.getBlockNumber();

  const addrPath = path.join(__dirname, "..", "proxy_addresses.json");
  if (!fs.existsSync(addrPath)) {
    throw new Error(
      "proxy_addresses.json not found.\n" +
      "Run deploy_proxy.js first."
    );
  }
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  const proxyAddr = addresses.proxy;

  console.log("=".repeat(60));
  console.log("  UPGRADE — MissionFailV1  →  MissionFailV2");
  console.log("  Model 2: Upgradeability via UUPS");
  console.log("=".repeat(60));
  console.log(`  Proxy    : ${proxyAddr}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Network  : ${hre.network.name}`);
  console.log("-".repeat(60));

  const v1           = await hre.ethers.getContractAt("MissionFailV1", proxyAddr);
  const activeBefore    = await v1.missionActive();
  const completedBefore = await v1.missionCompleted();
  const verBefore        = await v1.version();

  console.log("  State BEFORE upgrade:");
  console.log(`    version()          : ${verBefore}`);
  console.log(`    missionActive()    : ${activeBefore}`);
  console.log(`    missionCompleted() : ${completedBefore}`);
  console.log(`    uavCount()         : ${await v1.getUAVCount()}`);
  console.log("-".repeat(60));

  console.log("  [1/3] Deploying the MissionFailV2 implementation...");
  const V2Factory  = await hre.ethers.getContractFactory("MissionFailV2");
  const implV2     = await V2Factory.deploy(GAS);
  await implV2.waitForDeployment();
  const implV2Addr = await implV2.getAddress();
  console.log(`        Implementation V2 : ${implV2Addr}`);
  const deployReceipt = await implV2.deploymentTransaction().wait();
  trackAuthorityTx(deployReceipt, "deployV2");

  console.log("  [2/3] Upgrading via upgradeToAndCall()...");
  const initV2Data = V2Factory.interface.encodeFunctionData("initializeV2", []);

  const tx = await v1.connect(deployer).upgradeToAndCall(implV2Addr, initV2Data, GAS);
  const upgradeReceipt = await tx.wait();
  trackAuthorityTx(upgradeReceipt, "upgradeToAndCall");

  const v2             = await hre.ethers.getContractAt("MissionFailV2", proxyAddr);
  const activeAfter    = await v2.missionActive();
  const completedAfter = await v2.missionCompleted();
  const verAfter        = await v2.version();
  const score            = await v2.missionScore();

  console.log("-".repeat(60));
  console.log("  State AFTER upgrade:");
  console.log(`    version()          : ${verAfter}   ← LOGIC REPLACED ✓`);
  console.log(`    missionActive()    : ${activeAfter}   ← STATE PRESERVED ✓`);
  console.log(`    missionCompleted() : ${completedAfter}   ← STATE PRESERVED ✓`);
  console.log(`    uavCount()         : ${await v2.getUAVCount()}   ← STATE PRESERVED ✓`);
  console.log(`    missionScore()     : ${score}`);

  if (activeAfter !== activeBefore || completedAfter !== completedBefore) {
    throw new Error("CRITICAL ERROR: state corrupted during the upgrade!");
  }
  console.log("-".repeat(60));
  console.log("  ✓ V1 state fully preserved");

  addresses.implementationV2 = implV2Addr;
  addresses.upgradedAt = new Date().toISOString();
  fs.writeFileSync(addrPath, JSON.stringify(addresses, null, 2));

  console.log("  [3/3] proxy_addresses.json updated with implementationV2.");

  await finishAndSaveMetrics({
    provider: hre.ethers.provider, proxyAddress: proxyAddr, iface: v2.interface,
    fromBlock, model: "Modelo2-Proxy", scenario: "Fail-Upgrade", log: console.log,
  });

  console.log("=".repeat(60));
  console.log("  UPGRADE COMPLETE — logic replaced, state preserved");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n[ERROR] Upgrade failed:", err.message);
  process.exit(1);
});
