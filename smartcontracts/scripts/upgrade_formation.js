// scripts/upgrade_formation.js
// Manual upgrade MissionFormationV1 → MissionFormationV2.
//
// Usage:
//   npx hardhat run scripts/upgrade_formation.js --network rede-proxy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { trackAuthorityTx, finishAndSaveMetrics } = require("./lib/metrics");

const MISSION_OBJECTIVE = 3;

const GAS = { gasLimit: 3_000_000 };

// MAIN

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const fromBlock = await hre.ethers.provider.getBlockNumber();

  const addrPath = path.join(__dirname, "..", "formation_addresses.json");
  if (!fs.existsSync(addrPath)) throw new Error("formation_addresses.json not found.");
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  const proxyAddr = addresses.proxy;

  console.log("=".repeat(60));
  console.log("  UPGRADE — MissionFormationV1  →  MissionFormationV2");
  console.log("=".repeat(60));
  console.log(`  Proxy    : ${proxyAddr}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log("-".repeat(60));

  const v1 = await hre.ethers.getContractAt("MissionFormationV1", proxyAddr);
  console.log("  State BEFORE:");
  console.log(`    version()        : ${await v1.version()}`);
  console.log(`    UAVs             : ${await v1.getUAVCount()}`);
  const [cx, cy] = await v1.getCentroid();
  console.log(`    Centroid         : (${cx}, ${cy})`);
  console.log(`    missionActive    : ${await v1.missionActive()}`);

  console.log("\n  [1/3] Deploying the MissionFormationV2 implementation...");
  const V2Factory = await hre.ethers.getContractFactory("MissionFormationV2");
  const implV2    = await V2Factory.deploy(GAS);
  await implV2.waitForDeployment();
  const implV2Addr = await implV2.getAddress();
  console.log(`        Implementation V2 : ${implV2Addr}`);
  const deployReceipt = await implV2.deploymentTransaction().wait();
  trackAuthorityTx(deployReceipt, "deployV2");

  console.log("  [2/3] Upgrading via upgradeToAndCall()...");
  const initV2Data = V2Factory.interface.encodeFunctionData("initializeV2", [
    MISSION_OBJECTIVE,
  ]);
  const t0 = Date.now();
  const tx = await v1.connect(deployer).upgradeToAndCall(implV2Addr, initV2Data, GAS);
  const upgradeReceipt = await tx.wait();
  trackAuthorityTx(upgradeReceipt, "upgradeToAndCall");
  console.log(`        Upgrade completed in ${Date.now() - t0}ms`);

  const v2 = await hre.ethers.getContractAt("MissionFormationV2", proxyAddr);
  console.log("-".repeat(60));
  console.log("  State AFTER:");
  console.log(`    version()          : ${await v2.version()}   ← LOGIC REPLACED ✓`);
  console.log(`    UAVs preserved     : ${await v2.getUAVCount()} ✓`);
  const [cx2, cy2] = await v2.getCentroid();
  console.log(`    Centroid           : (${cx2}, ${cy2}) ✓`);
  console.log(`    missionObjective   : ${await v2.missionObjective()} healthy cycles`);
  console.log(`    v2Timestamp        : ${new Date(Number(await v2.v2Timestamp()) * 1000).toISOString()}`);

  addresses.implementationV2  = implV2Addr;
  addresses.upgradedAt        = new Date().toISOString();
  addresses.missionObjective  = MISSION_OBJECTIVE;
  fs.writeFileSync(addrPath, JSON.stringify(addresses, null, 2));

  console.log("\n  [3/3] formation_addresses.json updated.");

  await finishAndSaveMetrics({
    provider: hre.ethers.provider, proxyAddress: proxyAddr, iface: v2.interface,
    fromBlock, model: "Modelo2-Proxy", scenario: "Formation-Upgrade", log: console.log,
  });

  console.log("=".repeat(60));
  console.log("  UPGRADE COMPLETE");
  console.log("  Next step: npm run simulate:formation:v2");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n[ERROR]:", err.message);
  process.exit(1);
});
