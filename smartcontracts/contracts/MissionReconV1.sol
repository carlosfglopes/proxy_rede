// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title MissionReconV1 — upgradeable UUPS UAV reconnaissance-election contract
/// @notice Model 2 counterpart to MissionRecon: same weighted leader-election and
///         reporting behavior, upgraded via UUPS instead of an FSM.
/// @dev Storage layout is fixed from this version on — never reorder, remove, or
///      retype existing state variables in V2+, only append new ones.
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract MissionReconV1 is Initializable, OwnableUpgradeable, UUPSUpgradeable {

    // ENUMS

    enum ReportResult { NONE, TARGET_DETECTED, NOTHING_FOUND, INCONCLUSIVE }

    // STRUCTS

    struct UAVStatus {
        bool    permitted;
        bool    registered;
        bool    hasStatus;
        bool    ineligible;   
        uint256 battery;
        uint256 speed;
        uint256 score;
    }

    // STATE VARIABLES

    uint256 public minUAVsForElection;
    uint256 public reportTimeoutSec;
    uint256 public maxReelections;
    uint256 public weightBattery;
    uint256 public weightSpeed;

    uint256 public reelectionCount;
    uint256 public electionTimestamp;

    string       public missionZone;
    address      public electedLeader;
    ReportResult public finalReport;
    bytes32      public finalEvidenceHash;
    bool         public missionActive;
    bool         public missionCompleted;

    mapping(address => UAVStatus) public uavs;
    address[] public permittedUAVList;
    address[] public registeredUAVList;

    // EVENTS

    event UAVPermitted(address indexed uav);
    event MissionActivated(string zone);
    event UAVRegistered(address indexed uav);
    event StatusPublished(address indexed uav, uint256 battery, uint256 speed, uint256 score);
    event ElectionStarted(uint256 timestamp);
    event LeaderElected(address indexed leader, uint256 score);
    event ReportSubmitted(address indexed leader, ReportResult result, bytes32 evidenceHash);
    event ReelectionTriggered(uint256 count);
    event MissionCompleted(address indexed leader, ReportResult result);
    event MissionFailed(string reason);
    event ContractUpgraded(address indexed newImpl, uint256 timestamp);

    // MODIFIERS

    modifier onlyPermittedUAV() {
        require(uavs[msg.sender].permitted, "UAV not permitted");
        _;
    }

    modifier onlyRegisteredUAV() {
        require(uavs[msg.sender].registered, "UAV not registered");
        _;
    }

    modifier onlyLeader() {
        require(msg.sender == electedLeader, "Only elected leader");
        _;
    }

    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _owner,
        uint256 _minUAVsForElection,
        uint256 _reportTimeoutSec,
        uint256 _maxReelections,
        uint256 _weightBattery,
        uint256 _weightSpeed
    ) public initializer {
        require(_weightBattery + _weightSpeed == 100, "Weights must sum to 100");
        require(_minUAVsForElection > 0, "Invalid min UAVs");
        __Ownable_init(_owner);

        minUAVsForElection = _minUAVsForElection;
        reportTimeoutSec   = _reportTimeoutSec;
        maxReelections     = _maxReelections;
        weightBattery      = _weightBattery;
        weightSpeed        = _weightSpeed;
        missionActive      = false;
        missionCompleted   = false;
    }

    // MISSION FUNCTIONS

    function permitUAV(address _uav) external onlyOwner {
        require(_uav != address(0), "Invalid UAV");
        require(!uavs[_uav].permitted, "Already permitted");
        require(!missionActive, "Mission already started");
        uavs[_uav].permitted = true;
        permittedUAVList.push(_uav);
        emit UAVPermitted(_uav);
    }

    function activateMission(string calldata _zone) external onlyOwner {
        missionZone   = _zone;
        missionActive = true;
        emit MissionActivated(_zone);
    }

    function registerUAV() external onlyPermittedUAV {
        require(!uavs[msg.sender].registered, "Already registered");
        uavs[msg.sender].registered = true;
        registeredUAVList.push(msg.sender);
        emit UAVRegistered(msg.sender);
    }

    function publishStatus(
        uint256 _battery,
        uint256 _speed
    ) external onlyPermittedUAV onlyRegisteredUAV {
        uint256 score = (_battery * weightBattery) + (_speed * weightSpeed);
        uavs[msg.sender].battery   = _battery;
        uavs[msg.sender].speed     = _speed;
        uavs[msg.sender].score     = score;
        uavs[msg.sender].hasStatus = true;
        emit StatusPublished(msg.sender, _battery, _speed, score);
    }

    function startElection() external onlyOwner {
        require(registeredUAVList.length >= minUAVsForElection, "Not enough UAVs");
        for (uint256 i = 0; i < registeredUAVList.length; i++) {
            require(uavs[registeredUAVList[i]].hasStatus, "Missing UAV status");
        }
        electionTimestamp = block.timestamp;
        emit ElectionStarted(block.timestamp);
        _electLeader();
    }

    function submitReport(
        ReportResult _result,
        bytes32 _evidenceHash
    ) external onlyLeader virtual {
        finalReport       = _result;
        finalEvidenceHash = _evidenceHash;
        emit ReportSubmitted(electedLeader, _result, _evidenceHash);

        if (
            _result == ReportResult.TARGET_DETECTED ||
            _result == ReportResult.NOTHING_FOUND
        ) {
            missionCompleted = true;
            emit MissionCompleted(electedLeader, _result);
            return;
        }
        if (_result == ReportResult.INCONCLUSIVE) {
            _triggerReelectionOrFail("Inconclusive report");
        }
    }

    function checkTimeout() external {
        require(!missionCompleted, "Mission already completed");
        require(electedLeader != address(0), "No leader elected");
        require(
            block.timestamp > electionTimestamp + reportTimeoutSec,
            "Timeout not reached"
        );
        _triggerReelectionOrFail("Leader timeout");
    }

    // RESET

    function resetMission(string calldata _newZone) external virtual onlyOwner {
        for (uint256 i = 0; i < permittedUAVList.length; i++) {
            delete uavs[permittedUAVList[i]];
        }
        delete permittedUAVList;
        delete registeredUAVList;
        electedLeader     = address(0);
        finalReport       = ReportResult.NONE;
        finalEvidenceHash = bytes32(0);
        missionActive     = false;
        missionCompleted  = false;
        reelectionCount   = 0;
        electionTimestamp = 0;
        if (bytes(_newZone).length > 0) missionZone = _newZone;
    }

    // VIEW FUNCTIONS

    function getMissionSummary() external view returns (
        bool         active,
        bool         completed,
        string memory zone,
        address      leader,
        uint256      reelections,
        ReportResult report,
        bytes32      evidenceHash
    ) {
        return (
            missionActive, missionCompleted, missionZone,
            electedLeader, reelectionCount, finalReport, finalEvidenceHash
        );
    }

    function getRegisteredUAVCount() external view returns (uint256) {
        return registeredUAVList.length;
    }

    function getPermittedUAVCount() external view returns (uint256) {
        return permittedUAVList.length;
    }

    function version() external pure virtual returns (string memory) {
        return "V1";
    }

    // INTERNAL FUNCTIONS

    function _electLeader() internal {
        address bestUAV   = address(0);
        uint256 bestScore = 0;

        for (uint256 i = 0; i < registeredUAVList.length; i++) {
            address candidate = registeredUAVList[i];
            if (uavs[candidate].ineligible) continue;
            if (uavs[candidate].score > bestScore) {
                bestScore = uavs[candidate].score;
                bestUAV   = candidate;
            }
        }

        require(bestUAV != address(0), "No eligible leader");
        electedLeader = bestUAV;
        emit LeaderElected(bestUAV, bestScore);
    }

    function _triggerReelectionOrFail(string memory reason) internal {
        if (electedLeader != address(0)) {
            uavs[electedLeader].ineligible = true;
        }
        if (reelectionCount < maxReelections) {
            reelectionCount++;
            emit ReelectionTriggered(reelectionCount);
            _electLeader();
        } else {
            emit MissionFailed(reason);
        }
    }

    function _authorizeUpgrade(address newImpl)
        internal override onlyOwner
    {
        emit ContractUpgraded(newImpl, block.timestamp);
    }
}
