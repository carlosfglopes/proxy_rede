#!/usr/bin/env python3
"""
Autonomous UAV agent — MissionRecon (Model 2: Proxy/Upgradeability). Runs
independently on each RPi and connects to the local ERC1967 proxy via
web3.py, acting with its own key (msg.sender) — no FSM: mission progress is
read from simple flags (missionActive / missionCompleted) and the elected
leader's address.

Usage:
    UAV_ID=UAV1 PRIVATE_KEY=0x... CONTRACT_ADDRESS=0x... \
    BATTERY=92 SPEED=110 python3 agent_recon.py

Environment variables:
    RPC_URL          (default: http://127.0.0.1:8545)
    PRIVATE_KEY      (required)
    CONTRACT_ADDRESS (required — PROXY address, not the implementation)
    UAV_ID           (default: UAV1)
    BATTERY          (simulated battery level, default: 80)
    SPEED            (simulated speed, default: 100)
    REPORT_RESULT    (result to submit if elected leader — default: target_detected)
                     values: target_detected | nothing_found | inconclusive
"""

import os
import sys
import time
import hashlib
from web3 import Web3

# Configuration
RPC_URL          = os.getenv("RPC_URL", "http://127.0.0.1:8545")
PRIVATE_KEY       = os.getenv("PRIVATE_KEY")
CONTRACT_ADDRESS  = os.getenv("CONTRACT_ADDRESS")
UAV_ID            = os.getenv("UAV_ID", "UAV1")
BATTERY           = int(os.getenv("BATTERY", "80"))
SPEED             = int(os.getenv("SPEED", "100"))
REPORT_RESULT_STR = os.getenv("REPORT_RESULT", "target_detected")
POLL_INTERVAL     = 2

REPORT_RESULT_MAP = {
    "target_detected": 1,
    "nothing_found":   2,
    "inconclusive":    3,
}
REPORT_RESULT = REPORT_RESULT_MAP.get(REPORT_RESULT_STR, 1)

# ABI
ABI = [
    {"inputs": [], "name": "missionActive",
     "outputs": [{"type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "missionCompleted",
     "outputs": [{"type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "electedLeader",
     "outputs": [{"type": "address"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"type": "address"}], "name": "uavs",
     "outputs": [
         {"name": "permitted",  "type": "bool"},
         {"name": "registered", "type": "bool"},
         {"name": "hasStatus",  "type": "bool"},
         {"name": "ineligible", "type": "bool"},
         {"name": "battery",    "type": "uint256"},
         {"name": "speed",      "type": "uint256"},
         {"name": "score",      "type": "uint256"},
     ], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "registerUAV",
     "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"name": "_battery", "type": "uint256"}, {"name": "_speed", "type": "uint256"}],
     "name": "publishStatus", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"name": "_result", "type": "uint8"}, {"name": "_evidenceHash", "type": "bytes32"}],
     "name": "submitReport", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [], "name": "version",
     "outputs": [{"type": "string"}], "stateMutability": "pure", "type": "function"},
]

# Helpers

def log(msg):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] [{UAV_ID}] {msg}", flush=True)

def send_tx(w3, account, fn):
    tx = fn.build_transaction({
        "from":                 account.address,
        "nonce":                w3.eth.get_transaction_count(account.address),
        "gas":                  300000,
        "maxFeePerGas":         w3.to_wei("10", "gwei"),
        "maxPriorityFeePerGas": w3.to_wei("5", "gwei"),
    })
    signed  = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
    return receipt

# Main

def main():
    if not PRIVATE_KEY:
        print("ERROR: set PRIVATE_KEY"); sys.exit(1)
    if not CONTRACT_ADDRESS:
        print("ERROR: set CONTRACT_ADDRESS"); sys.exit(1)

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    if not w3.is_connected():
        print(f"ERROR: cannot connect to {RPC_URL}"); sys.exit(1)

    account  = w3.eth.account.from_key(PRIVATE_KEY)
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(CONTRACT_ADDRESS),
        abi=ABI
    )

    log(f"Connected to {RPC_URL} (proxy {CONTRACT_ADDRESS})")
    log(f"Address : {account.address}")
    log(f"Battery : {BATTERY}  Speed: {SPEED}")
    log(f"Version : {contract.functions.version().call()}")

    reported = False

    while True:
        if not w3.is_connected():
            log("No connection to node — retrying...")
            time.sleep(5)
            w3 = Web3(Web3.HTTPProvider(RPC_URL))
            continue

        try:
            completed = contract.functions.missionCompleted().call()
            if completed:
                log("Mission COMPLETED. Agent terminating.")
                break

            active = contract.functions.missionActive().call()
            uav    = contract.functions.uavs(account.address).call()
            permitted, registered, has_status, ineligible = uav[0], uav[1], uav[2], uav[3]
            leader = contract.functions.electedLeader().call()
            is_leader = leader.lower() == account.address.lower()

            log(
                f"active={active} permitted={permitted} registered={registered} "
                f"hasStatus={has_status} ineligible={ineligible} "
                f"leader={'ME' if is_leader else (leader if leader != '0x' + '0'*40 else '-')}"
            )

            if not permitted:
                log("Waiting for permission from the authority (permitUAV)...")

            elif not registered:
                log("Registering (registerUAV)...")
                r = send_tx(w3, account, contract.functions.registerUAV())
                log(f"Registered! Block #{r.blockNumber}")

            elif not has_status:
                log(f"Publishing status (battery={BATTERY}, speed={SPEED})...")
                r = send_tx(w3, account, contract.functions.publishStatus(BATTERY, SPEED))
                log(f"Status published! Block #{r.blockNumber}")

            elif is_leader and not ineligible and not reported:
                log(f"I am the elected leader — submitting report ({REPORT_RESULT_STR})...")
                evidence = hashlib.sha256(f"recon-evidence-{UAV_ID}-{time.time()}".encode()).digest()
                r = send_tx(w3, account, contract.functions.submitReport(REPORT_RESULT, evidence))
                log(f"Report submitted! Block #{r.blockNumber}")
                reported = True

        except Exception as e:
            log(f"Error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
