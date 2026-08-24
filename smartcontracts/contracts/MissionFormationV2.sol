// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title MissionFormationV2 — UUPS upgrade adding formation-health scoring
/// @notice Adds cycle tracking and a formation health score on top of V1, and
///         completes the mission once a configured number of healthy cycles is reached.
import "./MissionFormationV1.sol";

contract MissionFormationV2 is MissionFormationV1 {

    // NEW V2 STATE VARIABLES

    uint256 public v2Timestamp;
    uint256 public totalCycles;
    uint256 public healthyCycles;
    uint256 public degradedCycles;
    uint256 public formationScore;
    uint256 public missionObjective;

    // NEW V2 EVENTS

    event CycleRecorded(uint256 cycleNumber, uint256 healthPoints, uint256 totalScore);
    event ObjectiveReached(uint256 healthyCycles, uint256 totalScore);
    event MissionResetV2(uint256 timestamp);
    event MissionResetFull(uint256 timestamp);

    function initializeV2(uint256 _missionObjective) public reinitializer(2) {
        v2Timestamp      = block.timestamp;
        totalCycles      = 0;
        healthyCycles    = 0;
        degradedCycles   = 0;
        formationScore   = 0;
        missionObjective = _missionObjective;
    }

    // NEW V2 LOGIC

    function recordCycle() external onlyOwner inOperationalState {
        totalCycles++;

        (uint256 okCount, , , uint256 inactiveCount) = getSwarmCounts();
        uint256 activeCount = uavList.length - inactiveCount;

        uint256 healthPoints = activeCount > 0
            ? (okCount * 100) / activeCount
            : 0;

        formationScore += healthPoints;

        if (degraded || getNonOKCount() > 0) {
            degradedCycles++;
        } else {
            healthyCycles++;
        }

        emit CycleRecorded(totalCycles, healthPoints, formationScore);

        if (missionObjective > 0 && healthyCycles >= missionObjective) {
            missionCompleted = true;
            emit ObjectiveReached(healthyCycles, formationScore);
            emit MissionCompleted();
        }
    }

    function getFormationReport() external view returns (
        bool    active,
        bool    completed,
        bool    abortedFlag,
        bool    degradedFlag,
        uint256 formationId,
        int256  cx,
        int256  cy,
        uint256 totalUAVs,
        uint256 cycles,
        uint256 healthy,
        uint256 degradedCyclesOut,
        uint256 score,
        uint256 objective
    ) {
        return (
            missionActive, missionCompleted, aborted, degraded,
            currentFormation.formationId,
            centroidX, centroidY,
            uavList.length,
            totalCycles,
            healthyCycles,
            degradedCycles,
            formationScore,
            missionObjective
        );
    }

    // PARTIAL RESET (keeps UAVs, restarts cycles)

    function resetV2State() external onlyOwner {
        for (uint256 i = 0; i < uavList.length; i++) {
            address u = uavList[i];
            uavs[u].violationCount = 0;
            uavs[u].state          = UAVState.OK;
            _clearAllVotes(u);
        }

        totalCycles      = 0;
        healthyCycles    = 0;
        degradedCycles   = 0;
        formationScore   = 0;
        missionActive    = true;
        missionCompleted = false;
        aborted          = false;
        degraded         = false;

        emit MissionResetV2(block.timestamp);
    }

    // FULL RESET (fresh mission from scratch)

    function resetMission() external override onlyOwner {
        for (uint256 i = 0; i < uavList.length; i++) {
            address u = uavList[i];
            _clearAllVotes(u);
            delete uavs[u];
        }
        delete uavList;

        centroidX               = 0;
        centroidY                = 0;
        transitionEnd            = 0;
        formationChangePending   = false;
        pendingFormation         = FormationParams(0, 0, 0, 0);
        missionActive            = false;
        missionCompleted         = false;
        aborted                  = false;
        degraded                 = false;

        totalCycles    = 0;
        healthyCycles  = 0;
        degradedCycles = 0;
        formationScore = 0;

        emit MissionResetFull(block.timestamp);
    }

    function version() external pure override returns (string memory) {
        return "V2";
    }
}
