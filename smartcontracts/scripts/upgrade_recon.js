// scripts/upgrade_recon.js
// Manual upgrade MissionReconV1 → MissionReconV2.
//
// Usage:
//   npx hardhat run scripts/upgrade_recon.js --network rede-proxy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { trackAuthorityTx, finishAndSaveMetrics } = require("./lib/metrics");

const CONFIRMATION_THRESHOLD = 1;
const GAS = { gasLimit: 3_000_000 };

// MAIN

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const fromBlock = await hre.ethers.provider.getBlockNumber();

  const addrPath = path.join(__dirname, "..", "recon_addresses.json");
  if (!fs.existsSync(addrPath)) throw new Error("recon_addresses.json not found.");
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  const proxyAddr = addresses.proxy;

  console.log("=".repeat(60));
  console.log("  UPGRADE — MissionReconV1  →  MissionReconV2");
  console.log("=".repeat(60));
  console.log(`  Proxy    : ${proxyAddr}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log("-".repeat(60));

  const v1 = await hre.ethers.getContractAt("MissionReconV1", proxyAddr);
  const currentVersion = await v1.version();
  console.log("  State BEFORE:");
  console.log(`    version()   : ${currentVersion}`);
  console.log(`    UAVs        : ${await v1.getRegisteredUAVCount()}`);
  console.log(`    Leader      : ${await v1.electedLeader()}`);

  const alreadyV2 = currentVersion === "V2";
  if (alreadyV2) {
    console.log("\n  ⚠ Proxy is already on V2 — redeploying the implementation without the reinitializer.");
  }

  console.log("\n  [1/3] Deploying the MissionReconV2 implementation...");
  const V2Factory = await hre.ethers.getContractFactory("MissionReconV2");
  const implV2    = await V2Factory.deploy(GAS);
  await implV2.waitForDeployment();
  const implV2Addr = await implV2.getAddress();
  console.log(`        Implementation V2 : ${implV2Addr}`);
  const deployReceipt = await implV2.deploymentTransaction().wait();
  trackAuthorityTx(deployReceipt, "deployV2");

  console.log(`  [2/3] Upgrading via ${alreadyV2 ? "upgradeTo()" : "upgradeToAndCall()"}...`);
  const t0 = Date.now();
  let tx;
  if (alreadyV2) {
    tx = await v1.connect(deployer).upgradeToAndCall(implV2Addr, "0x", GAS);
  } else {
    const initV2Data = V2Factory.interface.encodeFunctionData("initializeV2", [
      CONFIRMATION_THRESHOLD,
    ]);
    tx = await v1.connect(deployer).upgradeToAndCall(implV2Addr, initV2Data, GAS);
  }
  const upgradeReceipt = await tx.wait();
  trackAuthorityTx(upgradeReceipt, "upgradeToAndCall");
  console.log(`        Upgrade completed in ${Date.now() - t0}ms`);

  const v2 = await hre.ethers.getContractAt("MissionReconV2", proxyAddr);
  console.log("-".repeat(60));
  console.log("  State AFTER:");
  console.log(`    version()             : ${await v2.version()}   ← LOGIC REPLACED ✓`);
  console.log(`    UAVs preserved        : ${await v2.getRegisteredUAVCount()} ✓`);
  console.log(`    Leader preserved      : ${await v2.electedLeader()} ✓`);
  console.log(`    confirmationThreshold : ${await v2.confirmationThreshold()}`);
  console.log(`    v2Timestamp           : ${new Date(Number(await v2.v2Timestamp()) * 1000).toISOString()}`);

  addresses.implementationV2      = implV2Addr;
  addresses.upgradedAt            = new Date().toISOString();
  addresses.confirmationThreshold = CONFIRMATION_THRESHOLD;
  fs.writeFileSync(addrPath, JSON.stringify(addresses, null, 2));

  console.log("\n  [3/3] recon_addresses.json updated.");

  await finishAndSaveMetrics({
    provider: hre.ethers.provider, proxyAddress: proxyAddr, iface: v2.interface,
    fromBlock, model: "Modelo2-Proxy", scenario: "Recon-Upgrade", log: console.log,
  });

  console.log("=".repeat(60));
  console.log("  UPGRADE COMPLETE");
  console.log("  Next step: npm run simulate:recon:v2");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n[ERROR]:", err.message);
  process.exit(1);
});
