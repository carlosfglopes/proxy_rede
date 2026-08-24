// scripts/deploy_formation.js
// Deploys the UUPS proxy + MissionFormationV1.
//
// Usage:
//   npx hardhat run scripts/deploy_formation.js --network rede-proxy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { trackAuthorityTx, finishAndSaveMetrics } = require("./lib/metrics");

const PARAMS = {
  toleranceWindow   : 30,
  maxViolations     : 2,
  degradedThreshold : 2,
  transitionTime    : 30,
  quorum            : 2,
  formationId       : 0,
  dMinSq            : 4_000_000,
  dMaxSq            : 64_000_000,
  rMaxSq            : 25_000_000,
};

const GAS = { gasLimit: 3_000_000 };

// MAIN

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const fromBlock = await hre.ethers.provider.getBlockNumber();

  console.log("=".repeat(60));
  console.log("  DEPLOY — MissionFormationV1 + ERC1967 Proxy (manual)");
  console.log("  Model 2: Upgradeability via UUPS — Scenario 3: Formation");
  console.log("=".repeat(60));
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Network  : ${hre.network.name}`);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`  Balance  : ${hre.ethers.formatEther(balance)} ETH`);
  if (balance === 0n) throw new Error("Zero balance!");
  console.log("-".repeat(60));

  console.log("  [1/4] Deploying the MissionFormationV1 implementation...");
  const V1Factory = await hre.ethers.getContractFactory("MissionFormationV1");
  const impl      = await V1Factory.deploy(GAS);
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`        Implementation V1 : ${implAddr}`);
  trackAuthorityTx(await impl.deploymentTransaction().wait(), "deployV1Implementation");

  const initData = V1Factory.interface.encodeFunctionData("initialize", [
    deployer.address,
    PARAMS.toleranceWindow,
    PARAMS.maxViolations,
    PARAMS.degradedThreshold,
    PARAMS.transitionTime,
    PARAMS.quorum,
    PARAMS.formationId,
    PARAMS.dMinSq,
    PARAMS.dMaxSq,
    PARAMS.rMaxSq,
  ]);

  console.log("  [2/4] Deploying the ERC1967 proxy...");
  const ProxyFactory = await hre.ethers.getContractFactory("ERC1967Proxy");
  const proxy        = await ProxyFactory.deploy(implAddr, initData, GAS);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log(`        Proxy (permanent) : ${proxyAddr}`);
  trackAuthorityTx(await proxy.deploymentTransaction().wait(), "deployProxy");

  const proxyAsV1 = await hre.ethers.getContractAt("MissionFormationV1", proxyAddr);
  console.log(`  [3/4] Verification via proxy:`);
  console.log(`        version()         : ${await proxyAsV1.version()}`);
  console.log(`        owner()           : ${await proxyAsV1.owner()}`);
  console.log(`        quorum            : ${await proxyAsV1.quorum()}`);
  console.log(`        maxViolations     : ${await proxyAsV1.maxViolations()}`);
  console.log(`        missionActive     : ${await proxyAsV1.missionActive()} (false = SETUP)`);

  const output = {
    network          : hre.network.name,
    deployedAt       : new Date().toISOString(),
    proxy            : proxyAddr,
    implementationV1 : implAddr,
    owner            : deployer.address,
    params           : PARAMS,
  };
  const outPath = path.join(__dirname, "..", "formation_addresses.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log("  [4/4] formation_addresses.json saved.");

  await finishAndSaveMetrics({
    provider: hre.ethers.provider, proxyAddress: proxyAddr, iface: proxyAsV1.interface,
    fromBlock, model: "Modelo2-Proxy", scenario: "Formation-Deploy", log: console.log,
  });

  console.log("=".repeat(60));
  console.log("  DEPLOY COMPLETE");
  console.log("  Next step: npm run simulate:formation:v1");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n[ERROR]:", err.message);
  process.exit(1);
});
