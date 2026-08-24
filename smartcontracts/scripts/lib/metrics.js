// scripts/lib/metrics.js
// Shared metrics collection module for the authority_*.js scripts
// (Models 2 and 3). Writes results to CSVs shared outside the repos, so
// they can be consolidated independently of which model/scenario
// generated them.
//
// Usage:
//
//   const { sendTx, finishAndSaveMetrics } = require("./lib/metrics");
//   ...
//   const fromBlock = await hre.ethers.provider.getBlockNumber();
//   ... (steps 1..N, all using sendTx(promise, "functionName ...detail") ...
//   await finishAndSaveMetrics({
//     provider: hre.ethers.provider,
//     proxyAddress: addresses.proxy,
//     iface: proxy.interface,
//     fromBlock,
//     model: "Modelo3-Hibrido",
//     scenario: "Formation",
//   });

const fs = require("fs");
const path = require("path");

const METRICS_DIR = "C:\\Users\\Escola Naval\\Documents\\Claude\\Projects\\Dissertação\\metricas";
const OPS_CSV  = path.join(METRICS_DIR, "resultados_operacoes.csv");
const RUNS_CSV = path.join(METRICS_DIR, "resultados_missao.csv");

const OPS_HEADER  = "timestamp,modelo,cenario,run_id,proxy,funcao,origem,n_chamadas,gas_total,gas_medio,reverted";
const RUNS_HEADER = "timestamp,modelo,cenario,run_id,proxy,from_block,to_block,n_blocos,duracao_segundos,n_tx_total,gas_total,remetentes_unicos,remetentes_lista";

function ensureCsv(filePath, header) {
  if (!fs.existsSync(METRICS_DIR)) fs.mkdirSync(METRICS_DIR, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, header + "\n");
}

function csvEscape(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function appendRow(filePath, header, row) {
  ensureCsv(filePath, header);
  fs.appendFileSync(filePath, row.map(csvEscape).join(",") + "\n");
}

let _authorityRecords = [];
let _authorityTxHashes = [];

function resetAccumulator() {
  _authorityRecords = [];
  _authorityTxHashes = [];
}

function trackAuthorityTx(receipt, label) {
  _authorityRecords.push({
    functionName: label.split(" ")[0],
    sender: receipt.from.toLowerCase(),
    gasUsed: Number(receipt.gasUsed),
    blockNumber: receipt.blockNumber,
    status: receipt.status,
    source: "authority",
  });
  _authorityTxHashes.push(receipt.hash.toLowerCase());
}

async function scanAgentTx(provider, proxyAddress, iface, fromBlock, toBlock) {
  const seen = new Set(_authorityTxHashes);
  const records = [];
  const proxyLower = proxyAddress.toLowerCase();

  for (let bn = fromBlock; bn <= toBlock; bn++) {
    const block = await provider.getBlock(bn, true);
    if (!block) continue;
    const txs = block.prefetchedTransactions || [];
    for (const tx of txs) {
      if (!tx.to || tx.to.toLowerCase() !== proxyLower) continue;
      if (seen.has(tx.hash.toLowerCase())) continue;

      let functionName = "unknown";
      try {
        const parsed = iface.parseTransaction({ data: tx.data });
        if (parsed) functionName = parsed.name;
      } catch (_) { /* selector not recognized by the given ABI */ }

      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (!receipt) continue;

      records.push({
        functionName,
        sender: tx.from.toLowerCase(),
        gasUsed: Number(receipt.gasUsed),
        blockNumber: receipt.blockNumber,
        status: receipt.status,
        source: "agent",
      });
    }
  }
  return records;
}

async function finishAndSaveMetrics({ provider, proxyAddress, iface, fromBlock, model, scenario, log }) {
  const toBlock = await provider.getBlockNumber();
  const agentRecords = await scanAgentTx(provider, proxyAddress, iface, fromBlock, toBlock);
  const records = _authorityRecords.concat(agentRecords);

  const fromBlockData = await provider.getBlock(fromBlock);
  const toBlockData = await provider.getBlock(toBlock);
  const durationSeconds = Number(toBlockData.timestamp) - Number(fromBlockData.timestamp);

  const runId = `${Date.now()}`;
  const ts = new Date().toISOString();

  const byFunction = {};
  const senders = new Set();
  let totalGas = 0;
  let totalReverted = 0;

  for (const r of records) {
    senders.add(r.sender);
    totalGas += r.gasUsed;
    if (Number(r.status) === 0) totalReverted++;
    const key = `${r.functionName}|${r.source}`;
    if (!byFunction[key]) byFunction[key] = { functionName: r.functionName, source: r.source, count: 0, gasSum: 0 };
    byFunction[key].count++;
    byFunction[key].gasSum += r.gasUsed;
  }

  for (const key in byFunction) {
    const f = byFunction[key];
    appendRow(OPS_CSV, OPS_HEADER, [
      ts, model, scenario, runId, proxyAddress, f.functionName, f.source,
      f.count, f.gasSum, Math.round(f.gasSum / f.count), "",
    ]);
  }

  appendRow(RUNS_CSV, RUNS_HEADER, [
    ts, model, scenario, runId, proxyAddress, fromBlock, toBlock,
    toBlock - fromBlock + 1, durationSeconds, records.length, totalGas, senders.size,
    Array.from(senders).join(";"),
  ]);

  const summary = {
    runId, fromBlock, toBlock,
    durationSeconds,
    totalTx: records.length,
    totalGas,
    uniqueSenders: senders.size,
    totalReverted,
    byFunction: Object.values(byFunction).sort((a, b) => b.gasSum - a.gasSum),
  };

  if (log) {
    log(`Blocks: ${fromBlock}→${toBlock} (${toBlock - fromBlock + 1}) | Duration: ${durationSeconds}s | Total tx: ${summary.totalTx} | Total gas: ${summary.totalGas} | Unique senders: ${summary.uniqueSenders} | Reverted: ${summary.totalReverted}`);
    for (const f of summary.byFunction) {
      log(`  ${f.functionName} (${f.source}): ${f.count}x | total gas ${f.gasSum} | average gas ${Math.round(f.gasSum / f.count)}`);
    }
    log(`CSV: ${OPS_CSV}`);
    log(`CSV: ${RUNS_CSV}`);
  }

  resetAccumulator();
  return summary;
}

module.exports = { trackAuthorityTx, finishAndSaveMetrics, resetAccumulator, OPS_CSV, RUNS_CSV };
