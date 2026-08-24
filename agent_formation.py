#!/usr/bin/env python3
"""
Autonomous UAV agent — MissionFormation (Model 2: Proxy/Upgradeability). Runs
independently on each RPi and connects to the local ERC1967 proxy via
web3.py, acting with its own key (msg.sender) — no FSM: mission progress is
read from simple flags (missionActive/missionCompleted/aborted/degraded).

Each agent:
  1. Periodically reports its own position (updatePosition).
  2. Reads the position/state of all registered peers.
  3. Reports violations (reportViolation) if a peer exceeds the distance
     constraints (dMinSq/dMaxSq between peers, rMaxSq to the centroid).
  4. Reports recovery (reportRecovery) if an OUT_OF_FORMATION peer is back
     within limits.

Usage:
    UAV_ID=UAV1 PRIVATE_KEY=0x... CONTRACT_ADDRESS=0x... \
    BASE_X=0 BASE_Y=0 python3 agent_formation.py

Environment variables:
    RPC_URL           (default: http://127.0.0.1:8545)
    PRIVATE_KEY       (required)
    CONTRACT_ADDRESS  (required — PROXY address)
    UAV_ID            (default: UAV1)
    BASE_X, BASE_Y    (this UAV's base position, default: 0, 0)
    POSITION_INTERVAL (seconds between updatePosition calls, default: 8)
    POLL_INTERVAL     (seconds between peer checks, default: 2)
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
BASE_X           = int(os.getenv("BASE_X", "0"))
BASE_Y           = int(os.getenv("BASE_Y", "0"))
POSITION_INTERVAL = int(os.getenv("POSITION_INTERVAL", "8"))
POLL_INTERVAL     = int(os.getenv("POLL_INTERVAL", "2"))

# States
UAV_STATES = {0: "OK", 1: "LATE", 2: "OUT_OF_FORMATION", 3: "INACTIVE"}

# ABI
ABI = [
    {"inputs": [], "name": "missionActive",
     "outputs": [{"type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "missionCompleted",
     "outputs": [{"type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "aborted",
     "outputs": [{"type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "degraded",
     "outputs": [{"type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"type": "address"}], "name": "uavs",
     "outputs": [
         {"name": "registered",     "type": "bool"},
         {"name": "state",         "type": "uint8"},
         {"name": "x",             "type": "int256"},
         {"name": "y",             "type": "int256"},
         {"name": "lastUpdate",    "type": "uint256"},
         {"name": "violationCount","type": "uint256"},
     ], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "getUAVCount",
     "outputs": [{"type": "uint256"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"type": "uint256"}], "name": "uavList",
     "outputs": [{"type": "address"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "currentFormation",
     "outputs": [
         {"name": "formationId", "type": "uint256"},
         {"name": "dMinSq",      "type": "uint256"},
         {"name": "dMaxSq",      "type": "uint256"},
         {"name": "rMaxSq",      "type": "uint256"},
     ], "stateMutability": "view", "type": "function"},
    {"inputs": [{"type": "address"}], "name": "getUAVStatus",
     "outputs": [
         {"name": "state",            "type": "uint8"},
         {"name": "x",                "type": "int256"},
         {"name": "y",                "type": "int256"},
         {"name": "lastUpdate",       "type": "uint256"},
         {"name": "violationCount",   "type": "uint256"},
         {"name": "distToCentroidSq", "type": "uint256"},
         {"name": "votes",           "type": "uint256"},
         {"name": "recovVotes",      "type": "uint256"},
     ], "stateMutability": "view", "type": "function"},
    {"inputs": [{"type": "address"}, {"type": "address"}], "name": "hasVoted",
     "outputs": [{"type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"type": "address"}, {"type": "address"}], "name": "hasVotedRecovery",
     "outputs": [{"type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"name": "_x", "type": "int256"}, {"name": "_y", "type": "int256"}],
     "name": "updatePosition", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"name": "_violator", "type": "address"}],
     "name": "reportViolation", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"name": "_uav", "type": "address"}],
     "name": "reportRecovery", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
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


def sq_dist(x1, y1, x2, y2):
    dx = x1 - x2
    dy = y1 - y2
    return dx * dx + dy * dy

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
    log(f"Address: {account.address}")
    log(f"Base position: ({BASE_X}, {BASE_Y})")

    last_position_ts = 0

    while True:
        if not w3.is_connected():
            log("No connection to node — retrying...")
            time.sleep(5)
            w3 = Web3(Web3.HTTPProvider(RPC_URL))
            continue

        try:
            completed = contract.functions.missionCompleted().call()
            is_aborted = contract.functions.aborted().call()
            if completed or is_aborted:
                log(f"Mission {'COMPLETED' if completed else 'ABORTED'}. Agent terminating.")
                break

            active = contract.functions.missionActive().call()
            me     = contract.functions.uavs(account.address).call()
            registered, my_state = me[0], me[1]

            if not active:
                log("Waiting for mission start (startMission)...")
                time.sleep(POLL_INTERVAL)
                continue

            if not registered:
                log("Not yet registered by the authority (registerUAV)...")
                time.sleep(POLL_INTERVAL)
                continue

            now = time.time()
            if now - last_position_ts >= POSITION_INTERVAL:
                r = send_tx(w3, account, contract.functions.updatePosition(BASE_X, BASE_Y))
                log(f"updatePosition({BASE_X},{BASE_Y}) sent! Block #{r.blockNumber}")
                last_position_ts = now

            formation = contract.functions.currentFormation().call()
            d_min_sq, d_max_sq, r_max_sq = formation[1], formation[2], formation[3]

            count = contract.functions.getUAVCount().call()
            for i in range(count):
                peer_addr = contract.functions.uavList(i).call()
                if peer_addr.lower() == account.address.lower():
                    continue

                status = contract.functions.getUAVStatus(peer_addr).call()
                peer_state, peer_x, peer_y, _, _, dist_centroid_sq = status[0], status[1], status[2], status[3], status[4], status[5]

                if peer_state == 3:
                    continue

                pair_dist_sq = sq_dist(BASE_X, BASE_Y, peer_x, peer_y)
                out_of_bounds = (
                    pair_dist_sq < d_min_sq or
                    pair_dist_sq > d_max_sq or
                    dist_centroid_sq > r_max_sq
                )

                if out_of_bounds and peer_state in (0, 1):
                    already = contract.functions.hasVoted(account.address, peer_addr).call()
                    if not already:
                        log(f"Peer {peer_addr[:10]}... out of bounds — reporting violation...")
                        r = send_tx(w3, account, contract.functions.reportViolation(peer_addr))
                        log(f"reportViolation sent! Block #{r.blockNumber}")

                elif not out_of_bounds and peer_state == 2:
                    already = contract.functions.hasVotedRecovery(account.address, peer_addr).call()
                    if not already:
                        log(f"Peer {peer_addr[:10]}... recovered — reporting recovery...")
                        r = send_tx(w3, account, contract.functions.reportRecovery(peer_addr))
                        log(f"reportRecovery sent! Block #{r.blockNumber}")

            degraded = contract.functions.degraded().call()
            log(f"active={active} myState={UAV_STATES.get(my_state, my_state)} degraded={degraded}")

        except Exception as e:
            log(f"Error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
