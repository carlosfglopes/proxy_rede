// scripts/fund_uavs.js
// Funds UAV1-4 accounts (standard test accounts, same as Model 1) from
// the authority account pre-funded in the rede-proxy genesis.
//
// Usage:
//   npx hardhat run scripts/fund_uavs.js --network rede-proxy

const hre = require("hardhat");

const UAV_ADDRESSES = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
];

const AMOUNT_ETH = "5";

async function main() {
  const [authority] = await hre.ethers.getSigners();

  console.log("=".repeat(60));
  console.log("  FUND UAVs — rede-proxy");
  console.log("=".repeat(60));
  console.log(`  Authority: ${authority.address}`);

  const balance = await hre.ethers.provider.getBalance(authority.address);
  console.log(`  Balance  : ${hre.ethers.formatEther(balance)} ETH`);
  console.log("-".repeat(60));

  for (let i = 0; i < UAV_ADDRESSES.length; i++) {
    const addr = UAV_ADDRESSES[i];
    const current = await hre.ethers.provider.getBalance(addr);
    console.log(`  UAV${i + 1} (${addr}) current balance: ${hre.ethers.formatEther(current)} ETH`);

    const tx = await authority.sendTransaction({
      to: addr,
      value: hre.ethers.parseEther(AMOUNT_ETH),
      gasPrice: 1_000_000_000,
    });
    const receipt = await tx.wait();
    console.log(`  → Sent ${AMOUNT_ETH} ETH | gas: ${receipt.gasUsed.toString()} | block: ${receipt.blockNumber}`);
  }

  console.log("=".repeat(60));
  console.log("  FUND COMPLETE");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n[ERROR]:", err.message);
  process.exit(1);
});
