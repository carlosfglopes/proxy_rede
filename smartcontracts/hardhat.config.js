require("@nomicfoundation/hardhat-ethers");
require("dotenv").config();

// ─── Nota de compatibilidade com Hyperledger Besu ──────────────────
//
//  O plugin @openzeppelin/hardhat-upgrades NÃO é usado nos scripts
//  deste projeto. Os deploys e upgrades são feitos manualmente com ethers
//  para evitar chamadas RPC incompatíveis com Besu QBFT:
//    - eth_feeHistory  (não suportada — por isso gasPrice fixo abaixo)
//    - eth_getStorageAt + validações internas do plugin
//
//  Esta configuração é propositadamente minimalista.
// ───────────────────────────────────────────────────────────────────

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.22",
    settings: {
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },

  networks: {
    // Rede local Hardhat (para testes rápidos sem Besu)
    hardhat: {
      mining: {
        auto: true,
        interval: 0,
      },
    },

    // Rede Hyperledger Besu — rede-proxy (Fase 2: Proxy Contracts)
    // proxy1 expõe a porta 8645 no host (rede_uav usa 8545 — sem conflito)
    // gasPrice fixo: evita eth_feeHistory (não suportada pelo Besu QBFT)
    "rede-proxy": {
      url: process.env.RPC_URL || "http://127.0.0.1:8645",
      accounts: process.env.PRIVATE_KEY
        ? [process.env.PRIVATE_KEY]
        : ["0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63"],
      chainId: 1339,
      timeout: 60000,
      gas: 4_000_000,
      gasPrice: 1_000_000_000, // 1 gwei — contorna eth_feeHistory no Besu
    },
  },

  // Gas reporter desligado por defeito
  gasReporter: {
    enabled: false,
  },
};
