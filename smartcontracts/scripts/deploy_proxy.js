// scripts/deploy_proxy.js
// Deploys MissionFailV1 (failure detection/voting FSM, in the same spirit
// as Model 1/3) + ERC1967 proxy.
//
// Usage:
//   npx hardhat run scripts/deploy_proxy.js --network rede-proxy

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { trackAuthorityTx, finishAndSaveMetrics } = require("./lib/metrics");

const INIT_PARAMS = [15, 2, 3, 5, 0];
const GAS = { gasLimit: 3_000_000 };

// MAIN

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const provider   = hre.ethers.provider;
  const fromBlock  = await provider.getBlockNumber();

  console.log("=".repeat(60));
  console.log("  DEPLOY — MissionFailV1 + ERC1967 Proxy (manual)");
  console.log("  Model 2: Upgradeability via UUPS");
  console.log("=".repeat(60));
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Network  : ${hre.network.name}`);

  const balance = await provider.getBalance(deployer.address);
  console.log(`  Balance  : ${hre.ethers.formatEther(balance)} ETH`);
  console.log("-".repeat(60));

  if (balance === 0n) {
    throw new Error("Zero balance! Check that rede-proxy is running.");
  }

  console.log("  [1/4] Deploying the MissionFailV1 implementation...");
  const V1Factory = await hre.ethers.getContractFactory("MissionFailV1");
  const impl      = await V1Factory.deploy(GAS);
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`        Implementation V1 : ${implAddr}`);
  trackAuthorityTx(await impl.deploymentTransaction().wait(), "deployV1Implementation");

  const initData = V1Factory.interface.encodeFunctionData("initialize", [
    deployer.address,
    ...INIT_PARAMS,
  ]);
  console.log("  [2/4] initialize() calldata encoded.");

  console.log("  [3/4] Deploying the ERC1967 proxy...");
  const ProxyFactory = await hre.ethers.getContractFactory("ERC1967Proxy");
  const proxy        = await ProxyFactory.deploy(implAddr, initData, GAS);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log(`        Proxy (permanent) : ${proxyAddr}`);
  trackAuthorityTx(await proxy.deploymentTransaction().wait(), "deployProxy");

  const proxyAsV1 = await hre.ethers.getContractAt("MissionFailV1", proxyAddr);
  const ver   = await proxyAsV1.version();
  const owner = await proxyAsV1.owner();
  console.log(`  [4/4] Verification via proxy:`);
  console.log(`        version()              : ${ver}`);
  console.log(`        missionActive()        : ${await proxyAsV1.missionActive()} (false = SETUP ✓)`);
  console.log(`        owner()                : ${owner}`);
  console.log(`        heartbeatTimeoutSec()  : ${await proxyAsV1.heartbeatTimeoutSec()}`);
  console.log(`        quorumThreshold()      : ${await proxyAsV1.quorumThreshold()}`);
  console.log(`        abortFailureThreshold(): ${await proxyAsV1.abortFailureThreshold()}`);

  const output = {
    network         : hre.network.name,
    deployedAt      : new Date().toISOString(),
    proxy           : proxyAddr,
    implementationV1: implAddr,
    owner           : deployer.address,
  };

  const outPath = path.join(__dirname, "..", "proxy_addresses.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log("-".repeat(60));
  console.log("  proxy_addresses.json saved.");

  await finishAndSaveMetrics({
    provider, proxyAddress: proxyAddr, iface: proxyAsV1.interface,
    fromBlock, model: "Modelo2-Proxy", scenario: "Fail-Deploy", log: console.log,
  });

  console.log("=".repeat(60));
  console.log("  DEPLOY COMPLETE");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n[ERROR] Deploy failed:", err.message);
  process.exit(1);
});
