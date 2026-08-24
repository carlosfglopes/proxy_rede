# proxy_rede — Model 2: Proxy / UUPS Upgradeability

Part of the MSc dissertation *"Dynamic Smart Contracts for Autonomous Agent Coordination."* This repo implements **Model 2**: the same three mission scenarios (failure response, formation-keeping, reconnaissance leader election) as upgradeable contracts behind an ERC1967/UUPS proxy, split into V1/V2 pairs. It measures the real cost of on-chain upgradeability against the other two models:

- Model 1 (fully decentralized FSM): [`fsm_rede`](https://github.com/carlosfglopes/fsm_rede)
- Model 3 (hybrid): [`hibrido_rede`](https://github.com/carlosfglopes/hibrido_rede)

## Setup

```bash
cd rede_uav && docker compose up -d      # starts the local Besu (IBFT2) network
cd ../smartcontracts && npm install
export RPC_URL=http://127.0.0.1:8545     # or the network's actual RPC endpoint
export PRIVATE_KEY=0x...                 # authority account
```

## Contracts (`smartcontracts/contracts/`)

| File | What it does |
|---|---|
| `ERC1967ProxyWrapper.sol` | Compile-only wrapper so Hardhat compiles OpenZeppelin's `ERC1967Proxy`. |
| `MissionFailV1.sol` | Failure-detection FSM equivalent, upgradeable via UUPS. |
| `MissionFailV2.sol` | Adds `missionScore`; deliberately small — isolates the cost of a UUPS upgrade. |
| `MissionFormationV1.sol` | Formation-keeping logic (centroid distance, violation/recovery voting), upgradeable via UUPS. |
| `MissionFormationV2.sol` | Adds cycle tracking and a formation health score on top of V1. |
| `MissionReconV1.sol` | Reconnaissance leader-election logic, upgradeable via UUPS. |
| `MissionReconV2.sol` | Adds a peer confirmation/rejection quorum for the leader's report. |

## Scripts (`smartcontracts/scripts/`)

| File | What it does | Command |
|---|---|---|
| `deploy_proxy.js` | Deploys MissionFailV1 + ERC1967 proxy. | `npx hardhat run scripts/deploy_proxy.js --network rede-proxy` |
| `deploy_formation.js` | Deploys the UUPS proxy + MissionFormationV1. | `npx hardhat run scripts/deploy_formation.js --network rede-proxy` |
| `deploy_recon.js` | Deploys the UUPS proxy + MissionReconV1. | `npx hardhat run scripts/deploy_recon.js --network rede-proxy` |
| `fund_uavs.js` | Funds UAV1-4 test accounts from the authority account. | `npx hardhat run scripts/fund_uavs.js --network rede-proxy` |
| `upgrade_proxy.js` | Upgrades MissionFailV1 → MissionFailV2. | `npx hardhat run scripts/upgrade_proxy.js --network rede-proxy` |
| `upgrade_formation.js` | Upgrades MissionFormationV1 → MissionFormationV2. | `npx hardhat run scripts/upgrade_formation.js --network rede-proxy` |
| `upgrade_recon.js` | Upgrades MissionReconV1 → MissionReconV2. | `npx hardhat run scripts/upgrade_recon.js --network rede-proxy` |
| `authority_fail.js` | Authority run for MissionFail: registers UAVs, starts the mission, triggers an incident, finalizes. | `npx hardhat run scripts/authority_fail.js --network rede-proxy` |
| `authority_formation.js` | Authority run for MissionFormation: registers UAVs, starts and monitors the mission. | `npx hardhat run scripts/authority_formation.js --network rede-proxy` |
| `authority_recon.js` | Authority run for MissionRecon: permits UAVs, activates the mission, triggers the election. | `npx hardhat run scripts/authority_recon.js --network rede-proxy` |
| `simulate_v1.js` | MissionFail scenario simulation with V1 logic (`$env:SCENARIO=heartbeat_fail\|battery_low\|abort`). | `npx hardhat run scripts/simulate_v1.js --network rede-proxy` |
| `simulate_v2.js` | MissionFail scenario simulation with V2 logic (same scenarios as V1). | `npx hardhat run scripts/simulate_v2.js --network rede-proxy` |
| `simulate_formation_v1.js` | Formation scenario simulation with V1 logic (`$env:SCENARIO=nominal\|violation\|late`). | `npx hardhat run scripts/simulate_formation_v1.js --network rede-proxy` |
| `simulate_formation_v2.js` | Formation scenario simulation with V2 logic, plus health scoring. | `npx hardhat run scripts/simulate_formation_v2.js --network rede-proxy` |
| `simulate_recon_v1.js` | Recon scenario simulation with V1 logic (`$env:SCENARIO=target_detected\|nothing_found\|inconclusive`). | `npx hardhat run scripts/simulate_recon_v1.js --network rede-proxy` |
| `simulate_recon_v2.js` | Recon scenario simulation with V2 logic (same scenarios as V1). | `npx hardhat run scripts/simulate_recon_v2.js --network rede-proxy` |
| `run_all.js` | Runs the full Scenario 1 end to end — fresh deploy, or reset if already on V2. | `npx hardhat run scripts/run_all.js --network rede-proxy` |
| `reset_mission.js` | Clears MissionFail proxy state to run a new mission without redeploying (V1 or V2). | `npx hardhat run scripts/reset_mission.js --network rede-proxy` |
| `reset_v2.js` | Partial reset of MissionFail — clears V2 state but keeps UAVs and the mission. | `npx hardhat run scripts/reset_v2.js --network rede-proxy` |
| `reset_formation.js` | Full reset of the MissionFormation mission (V1 or V2). | `npx hardhat run scripts/reset_formation.js --network rede-proxy` |
| `reset_formation_v2.js` | Partial reset of MissionFormation V2 — keeps registered UAVs. | `npx hardhat run scripts/reset_formation_v2.js --network rede-proxy` |
| `reset_recon_v1.js` | Full reset of the MissionRecon mission (V1). | `npx hardhat run scripts/reset_recon_v1.js --network rede-proxy` |
| `reset_recon_v2.js` | Partial reset of MissionRecon V2 — keeps registered UAVs. | `npx hardhat run scripts/reset_recon_v2.js --network rede-proxy` |
| `reset_recon.js` | Full reset of the MissionRecon mission (V2). Requires the V2 upgrade first. | `npx hardhat run scripts/reset_recon.js --network rede-proxy` |
| `lib/metrics.js` | Shared gas/latency metrics-collection module (imported, not run directly). | — |

## Agent scripts (Python)

| File | What it does | Command |
|---|---|---|
| `agent_fail.py` | Autonomous UAV agent for MissionFail, one instance per Raspberry Pi: heartbeats and votes. | `UAV_ID=UAV1 PRIVATE_KEY=0x... CONTRACT_ADDRESS=0x... python3 agent_fail.py` |
| `agent_formation.py` | Autonomous UAV agent for MissionFormation: reports its own position, votes on peer violations/recoveries. | `UAV_ID=UAV1 PRIVATE_KEY=0x... CONTRACT_ADDRESS=0x... python3 agent_formation.py` |
| `agent_recon.py` | Autonomous UAV agent for MissionRecon: registers, publishes status, submits the report if elected leader. | `UAV_ID=UAV1 PRIVATE_KEY=0x... CONTRACT_ADDRESS=0x... python3 agent_recon.py` |

## Citation

If you use this code, please cite the dissertation this repository accompanies (Carlos Gollwitzer Lopes, *"Dynamic Smart Contracts for Autonomous Agent Coordination,"* Escola Naval).
