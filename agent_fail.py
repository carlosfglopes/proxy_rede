#!/usr/bin/env python3
"""
Autonomous UAV agent — MissionFail (Model 2: Proxy/Upgradeability). Runs
independently on each RPi and connects to the local ERC1967 proxy via
web3.py, acting with its own key (msg.sender). Failure detection/voting is
decentralized, but there is no mission-state FSM enum — progress is read
from simple boolean flags (missionActive/missionCompleted/aborted/degraded)
and a nonzero suspectUav indicates an incident under confirmation. UAV
registration is still done by the authority (registerUAV is onlyOwner); the
agent reacts by sending heartbeats and voting on suspects.

Usage:
    UAV_ID=UAV1 PRIVATE_KEY=0x... CONTRACT_ADDRESS=0x... python3 agent_fail.py

Environment variables:
    RPC_URL          (default: http://127.0.0.1:8545)
    PRIVATE_KEY      (required)
    CONTRACT_ADDRESS (required — PROXY address)
    UAV_ID           (default: UAV1)
"""

import os
import sys
import time
from web3 import Web3

# Configuration
RPC_URL          = os.getenv("RPC_URL", "http://127.0.0.1:8545")
PRIVATE_KEY      = os.getenv("PRIVATE_KEY")
CONTRACT_ADDRESS = os.getenv("CONTRACT_ADDRESS")
UAV_ID           = os.getenv("UAV_ID", "UAV1")
POLL_INTERVAL      = 2
HEARTBEAT_INTERVAL = 8
ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

# ABI
ABI = [
    {"inputs": [], "name": "missionActive",
     "outputs": [{"type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "missionCompleted",
     "outputs": [{"type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "aborted",
     "outputs": [{"type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"type": "address"}], "name": "uavs",
     "outputs": [
         {"name": "registered",    "type": "bool"},
         {"name": "operational",   "type": "bool"},
         {"name": "lastHeartbeat", "type": "uint256"},
         {"name": "capacityMax",   "type": "uint256"},
         {"name": "loadCurrent",   "type": "uint256"},
     ], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "suspectUav",
     "outputs": [{"type": "address"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"type": "address"}], "name": "hasVotedOnCurrentIncident",
     "outputs": [{"type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "heartbeat",
     "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"name": "vote", "type": "uint8"}], "name": "voteOnSuspect",
     "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [], "name": "getMissionSummary",
     "outputs": [
         {"name": "active",       "type": "bool"},
         {"name": "completed",    "type": "bool"},
         {"name": "abortedFlag",  "type": "bool"},
         {"name": "degradedFlag", "type": "bool"},
         {"name": "failures",     "type": "uint256"},
         {"name": "activeUAVs",   "type": "uint256"},
         {"name": "activeTasks",  "type": "uint256"},
         {"name": "suspect",      "type": "address"},
         {"name": "reason",       "type": "uint8"},
         {"name": "vFailed",      "type": "uint256"},
         {"name": "vByzantine",   "type": "uint256"},
         {"name": "vReject",      "type": "uint256"},
     ], "stateMutability": "view", "type": "function"},
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
    return w3.eth.wait_for_transaction_receipt(tx_hash)


def state_label(s):
    if s[2]: return "ABORTED"
    if s[1]: return "COMPLETED"
    if s[7] != ZERO_ADDRESS: return "UNDER_CONFIRMATION"
    if s[3]: return "DEGRADED"
    if s[0]: return "ACTIVE"
    return "SETUP"

# Main

def main():
    if not PRIVATE_KEY:
        print("ERROR: set PRIVATE_KEY"); sys.exit(1)
    if not CONTRACT_ADDRESS:
        print("ERROR: set CONTRACT_ADDRESS"); sys.exit(1)

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    try:
        w3.eth.block_number
    except Exception as e:
        print(f"ERROR: cannot connect to {RPC_URL} ({e})"); sys.exit(1)

    account  = w3.eth.account.from_key(PRIVATE_KEY)
    contract = w3.eth.contract(address=Web3.to_checksum_address(CONTRACT_ADDRESS), abi=ABI)

    log(f"Connected to {RPC_URL} (proxy {CONTRACT_ADDRESS})")
    log(f"Address: {account.address}")

    last_heartbeat = 0

    while True:
        try:
            summary = contract.functions.getMissionSummary().call()
            active, completed, aborted_flag = summary[0], summary[1], summary[2]
            failures    = summary[4]
            active_uavs = summary[5]
            suspect     = summary[7]

            uav_data = contract.functions.uavs(account.address).call()
            registered, operational = uav_data[0], uav_data[1]

            log(
                f"Mission: {state_label(summary)} | registered={registered} operational={operational} "
                f"| Failures: {failures} | Active UAVs: {active_uavs}"
            )

            if completed or aborted_flag:
                log(f"Mission {'COMPLETED' if completed else 'ABORTED'}. Agent terminating.")
                break

            under_confirmation = suspect != ZERO_ADDRESS

            if not under_confirmation:
                if registered and operational:
                    now = time.time()
                    if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                        log("Sending heartbeat...")
                        r = send_tx(w3, account, contract.functions.heartbeat())
                        log(f"Heartbeat sent! Block #{r.blockNumber}")
                        last_heartbeat = now
                elif not registered:
                    log("Waiting for registration by the authority...")
                else:
                    log("UAV not operational — no heartbeat")
            else:
                if suspect.lower() != account.address.lower():
                    already_voted = contract.functions.hasVotedOnCurrentIncident(account.address).call()
                    if not already_voted:
                        log(f"Suspect: {suspect[:10]}... Voting CONFIRM_FAILED...")
                        r = send_tx(w3, account, contract.functions.voteOnSuspect(1))
                        log(f"Vote recorded! Block #{r.blockNumber}")
                    else:
                        log(f"Already voted. Votes — Failed:{summary[9]} Byzantine:{summary[10]} Reject:{summary[11]}")
                else:
                    log("I am the suspect — cannot vote")

        except Exception as e:
            log(f"Error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
