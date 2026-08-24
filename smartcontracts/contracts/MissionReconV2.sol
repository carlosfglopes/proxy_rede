// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title MissionReconV2 — UUPS upgrade adding peer confirmation of reports
/// @notice Adds a confirmation/rejection quorum for the leader's report before
///         it becomes final, on top of the V1 election/report flow.
import "./MissionReconV1.sol";

contract MissionReconV2 is MissionReconV1 {

    // NEW V2 STATE VARIABLES

    uint256 public v2Timestamp;
    uint256 public confirmationThreshold;
    uint256 public confirmationCount;
    uint256 public rejectionCount;

    ReportResult public pendingReport;
    bytes32      public pendingEvidenceHash;
    bool         public reportPending;

    mapping(address => bool) public hasVoted;

    // NEW V2 EVENTS

    event ReportPendingConfirmation(address indexed leader, ReportResult result, bytes32 evidenceHash);
    event FindingConfirmed(address indexed uav, uint256 totalConfirms);
    event FindingRejected(address indexed uav, uint256 totalRejections);
    event ConsensusReached(ReportResult result, uint256 confirms, uint256 rejections);
    event MissionResetV2(uint256 timestamp);
    event MissionResetFull(uint256 timestamp);

    // NEW V2 INITIALIZATION

    function initializeV2(uint256 _confirmationThreshold) public reinitializer(2) {
        v2Timestamp           = block.timestamp;
        confirmationThreshold = _confirmationThreshold;
        confirmationCount     = 0;
        rejectionCount        = 0;
        reportPending         = false;
    }

    // NEW V2 LOGIC

    function submitReportForConfirmation(
        ReportResult _result,
        bytes32 _evidenceHash
    ) external onlyLeader {
        require(!reportPending, "Report already pending");

        pendingReport       = _result;
        pendingEvidenceHash = _evidenceHash;
        reportPending       = true;

        emit ReportPendingConfirmation(electedLeader, _result, _evidenceHash);
    }

    function confirmFinding(bool _confirm) external onlyRegisteredUAV {
        require(reportPending,              "No report pending");
        require(msg.sender != electedLeader, "Leader cannot confirm own report");
        require(!hasVoted[msg.sender],       "Already voted");

        hasVoted[msg.sender] = true;

        if (_confirm) {
            confirmationCount++;
            emit FindingConfirmed(msg.sender, confirmationCount);
        } else {
            rejectionCount++;
            emit FindingRejected(msg.sender, rejectionCount);
        }
    }

    function finalizeConsensus() external onlyOwner {
        require(reportPending,                         "No report pending");
        require(confirmationCount >= confirmationThreshold, "Threshold not reached");

        finalReport       = pendingReport;
        finalEvidenceHash = pendingEvidenceHash;
        reportPending     = false;
        missionCompleted  = true;

        emit ConsensusReached(finalReport, confirmationCount, rejectionCount);
        emit MissionCompleted(electedLeader, finalReport);
    }

    function getReconReport() external view returns (
        bool         active,
        bool         completed,
        string memory zone,
        address      leader,
        ReportResult report,
        bytes32      evidenceHash,
        uint256      confirms,
        uint256      rejections,
        bool         pending
    ) {
        return (
            missionActive, missionCompleted, missionZone,
            electedLeader, finalReport, finalEvidenceHash,
            confirmationCount, rejectionCount, reportPending
        );
    }

    // PARTIAL RESET (keeps UAVs, restarts mission)

    function resetV2State() external onlyOwner {
        for (uint256 i = 0; i < registeredUAVList.length; i++) {
            address uav = registeredUAVList[i];
            hasVoted[uav]           = false;
            uavs[uav].ineligible    = false;
        }

        confirmationCount   = 0;
        rejectionCount      = 0;
        reportPending       = false;
        pendingReport       = ReportResult.NONE;
        pendingEvidenceHash = bytes32(0);
        missionCompleted    = false;
        finalReport         = ReportResult.NONE;
        finalEvidenceHash   = bytes32(0);
        electedLeader       = address(0);
        reelectionCount     = 0;
        missionActive       = true;

        emit MissionResetV2(block.timestamp);
    }

    // FULL RESET (fresh mission from scratch)

    function resetMission(string calldata _newZone) external override onlyOwner {
        for (uint256 i = 0; i < registeredUAVList.length; i++) {
            address uav = registeredUAVList[i];
            uavs[uav].registered = false;
            uavs[uav].hasStatus  = false;
            uavs[uav].ineligible = false;
            uavs[uav].battery    = 0;
            uavs[uav].speed      = 0;
            uavs[uav].score      = 0;
            hasVoted[uav]        = false;
        }
        for (uint256 i = 0; i < permittedUAVList.length; i++) {
            uavs[permittedUAVList[i]].permitted = false;
        }

        delete registeredUAVList;
        delete permittedUAVList;

        missionZone         = _newZone;
        missionActive       = false;
        missionCompleted    = false;
        electedLeader       = address(0);
        finalReport         = ReportResult.NONE;
        finalEvidenceHash   = bytes32(0);
        reelectionCount     = 0;
        electionTimestamp   = 0;
        confirmationCount   = 0;
        rejectionCount      = 0;
        reportPending       = false;
        pendingReport       = ReportResult.NONE;
        pendingEvidenceHash = bytes32(0);

        emit MissionResetFull(block.timestamp);
    }

    function version() external pure override returns (string memory) {
        return "V2";
    }
}
