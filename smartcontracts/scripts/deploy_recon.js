// scripts/deploy_recon.js
// Deploys the UUPS proxy + MissionReconV1.
//
// Usage:
//   npx hardhat run scripts/deploy_recon.js --network rede-proxy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { trackAuthorityTx, finishAndSaveMetrics } = require("./lib/metrics");

const MISSION_ZONE = "Zone-Alpha";
const PARAMS = {
  minUAVsForElection: 2,
  reportTimeoutSec  : 20,
  maxReelections    : 2,
  weightBattery     : 60,
  weightSpeed       : 40,
};
const GAS = { gasLimit: 3_000_000 };

// MAIN

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const fromBlock = await hre.ethers.provider.getBlockNumber();

  console.log("=".repeat(60));
  console.log("  DEPLOY — MissionReconV1 + ERC1967 Proxy (manual)");
  console.log("  Model 2: Upgradeability via UUPS");
  console.log("=".repeat(60));
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Network  : ${hre.network.name}`);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`  Balance  : ${hre.ethers.formatEther(balance)} ETH`);
  if (balance === 0n) throw new Error("Zero balance!");
  console.log("-".repeat(60));

  console.log("  [1/4] Deploying the MissionReconV1 implementation...");
  const V1Factory = await hre.ethers.getContractFactory("MissionReconV1");
  const impl      = await V1Factory.deploy(GAS);
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`        Implementation V1 : ${implAddr}`);
  trackAuthorityTx(await impl.deploymentTransaction().wait(), "deployV1Implementation");

  const initData = V1Factory.interface.encodeFunctionData("initialize", [
    deployer.address,
    PARAMS.minUAVsForElection,
    PARAMS.reportTimeoutSec,
    PARAMS.maxReelections,
    PARAMS.weightBattery,
    PARAMS.weightSpeed,
  ]);

  console.log("  [2/4] Deploying the ERC1967 proxy...");
  const ProxyFactory = await hre.ethers.getContractFactory("ERC1967Proxy");
  const proxy        = await ProxyFactory.deploy(implAddr, initData, GAS);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log(`        Proxy (permanent) : ${proxyAddr}`);
  trackAuthorityTx(await proxy.deploymentTransaction().wait(), "deployProxy");

  const proxyAsV1 = await hre.ethers.getContractAt("MissionReconV1", proxyAddr);
  console.log(`  [3/4] Verification via proxy:`);
  console.log(`        version()         : ${await proxyAsV1.version()}`);
  console.log(`        owner()           : ${await proxyAsV1.owner()}`);
  console.log(`        weightBattery     : ${await proxyAsV1.weightBattery()}`);
  console.log(`        weightSpeed       : ${await proxyAsV1.weightSpeed()}`);

  const output = {
    network         : hre.network.name,
    deployedAt      : new Date().toISOString(),
    proxy           : proxyAddr,
    implementationV1: implAddr,
    owner           : deployer.address,
    missionZone     : MISSION_ZONE,
    params          : PARAMS,
  };
  const outPath = path.join(__dirname, "..", "recon_addresses.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log("  [4/4] recon_addresses.json saved.");

  await finishAndSaveMetrics({
    provider: hre.ethers.provider, proxyAddress: proxyAddr, iface: proxyAsV1.interface,
    fromBlock, model: "Modelo2-Proxy", scenario: "Recon-Deploy", log: console.log,
  });

  console.log("=".repeat(60));
  console.log("  DEPLOY COMPLETE");
  console.log("  Next step: npm run simulate:recon:v1");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n[ERROR]:", err.message);
  process.exit(1);
});
