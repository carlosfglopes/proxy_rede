// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title MissionFailV2 — UUPS upgrade adding a mission score
/// @notice Deliberately small: measures the real cost of a UUPS upgrade
///         (deployV2 + upgradeToAndCall) over an already-equivalent V1.
import "./MissionFailV1.sol";

contract MissionFailV2 is MissionFailV1 {

    uint256 public missionScore;

    event MissionScoreUpdated(uint256 score, bool completed);

    function initializeV2() public reinitializer(2) {
        missionScore = 0;
    }

    function version() external pure override returns (string memory) {
        return "V2";
    }

    function resetMission() public override onlyOwner {
        super.resetMission();
        missionScore = 0;
    }

    function setMissionScore(uint256 _score) external onlyOwner {
        require(_score <= 100, "Score must be 0-100");
        missionScore = _score;
        emit MissionScoreUpdated(_score, missionCompleted);
    }
}
