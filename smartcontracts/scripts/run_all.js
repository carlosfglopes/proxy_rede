// scripts/run_all.js
// Runs the full Scenario 1 — fresh deploy, or reset if already on V2.
//
// Usage:
//   npx hardhat run scripts/run_all.js --network rede-proxy
//
// Behavior:
//   • First time (no proxy_addresses.json):
//       deploy → simulate_v1 → upgrade → simulate_v2
//
//   • Subsequent times (already on V2):
//       resetMission() → simulate_v1 → simulate_v2
//       (no redeploy — the proxy is permanent)

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const ADDR_PATH   = path.join(__dirname, "..", "proxy_addresses.json");
const MISSION_NAME = "Missao_Resposta_Falha_UAV_V1";
const GAS = { gasLimit: 3_000_000 };

// HELPERS

function sep(label) {
  console.log(`\n${"=".repeat(60)}`);
  if (label) console.log(`  ${label}`);
  console.log("=".repeat(60));
}

function runScript(script) {
  sep(`Running: ${script}`);
  require("./" + script.replace(".js", ""));
}

// MAIN

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  const hasAddresses  = fs.existsSync(ADDR_PATH);
  const addresses     = hasAddresses ? JSON.parse(fs.readFileSync(ADDR_PATH, "utf8")) : null;
  const alreadyOnV2   = addresses && addresses.implementationV2;

  if (alreadyOnV2) {
    sep("RESET MODE — Proxy V2 already exists, reusing it");
    console.log(`  Proxy    : ${addresses.proxy}`);
    console.log(`  Impl V2  : ${addresses.implementationV2}`);
    console.log(`  Deployer : ${deployer.address}`);

    const proxy = await hre.ethers.getContractAt("MissionFailV2", addresses.proxy);

    console.log("\n  Calling resetMission()...");
    const tx = await proxy.connect(deployer).resetMission(MISSION_NAME, GAS);
    await tx.wait();
    console.log("  ✓ State cleared — proxy ready for a new mission");
    console.log(`  Version  : ${await proxy.version()}`);

  } else {
    sep("DEPLOY MODE — Doing a fresh deploy");
    const { execSync } = require("child_process");
    execSync(
      `npx hardhat run scripts/deploy_proxy.js --network ${hre.network.name}`,
      { stdio: "inherit", cwd: path.join(__dirname, "..") }
    );
    execSync(
      `npx hardhat run scripts/upgrade_proxy.js --network ${hre.network.name}`,
      { stdio: "inherit", cwd: path.join(__dirname, "..") }
    );
  }

  const { execSync } = require("child_process");
  execSync(
    `npx hardhat run scripts/simulate_v1.js --network ${hre.network.name}`,
    { stdio: "inherit", cwd: path.join(__dirname, "..") }
  );
  execSync(
    `npx hardhat run scripts/simulate_v2.js --network ${hre.network.name}`,
    { stdio: "inherit", cwd: path.join(__dirname, "..") }
  );

  sep("DONE");
  console.log("  To run again: npx hardhat run scripts/run_all.js --network rede-proxy");
}

main().catch((err) => {
  console.error("\n[ERROR]:", err.message);
  process.exitCode = 1;
});
