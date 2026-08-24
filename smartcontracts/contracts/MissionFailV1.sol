// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title MissionFailV1 — upgradeable UUPS UAV failure-detection contract
/// @notice Model 2 counterpart to MissionFail: same heartbeat/quorum/reconfiguration
///         behavior, but progress is tracked with independent boolean flags instead
///         of an FSM enum, since dynamism here comes from UUPS upgrades, not state
///         transitions.
/// @dev Storage layout is fixed from this version on — never reorder, remove, or
///      retype existing state variables in V2+, only append new ones.
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract MissionFailV1 is Initializable, OwnableUpgradeable, UUPSUpgradeable {

    // ENUMS

    enum ReasonCode { NONE, NO_HEARTBEAT, MALICIOUS_BEHAVIOR }
    enum VoteChoice { NONE, CONFIRM_FAILED, CONFIRM_BYZANTINE, REJECT }
    enum FormationMode { FULL, REDUCED, MINIMAL }

    // STRUCTS

    struct UAV {
        bool    registered;
        bool    operational;
        uint256 lastHeartbeat;
        uint256 capacityMax;
        uint256 loadCurrent;
    }

    struct Task {
        uint256 id;
        address assignedTo;
        bool    active;
    }

    // STATE VARIABLES

    bool public missionActive;
    bool public missionCompleted;
    bool public aborted;
    bool public degraded;
    bool public reconfigurationPending;

    uint256       public heartbeatTimeoutSec;
    uint256       public quorumThreshold;
    uint256       public abortFailureThreshold;
    uint256       public failureCount;
    uint256       public degradedCapacityThreshold;
    FormationMode public formationMode;

    address[] public uavList;
    uint256[] public activeTaskIds;

    mapping(address => UAV)  public uavs;
    mapping(uint256 => Task) public tasks;

    address    public suspectUav;
    ReasonCode public currentReason;
    bytes32    public currentEvidenceHash;
    uint256    public incidentTimestamp;
    uint256    public votesForFailed;
    uint256    public votesForByzantine;
    uint256    public votesReject;

    mapping(address => bool) public hasVotedOnCurrentIncident;

    // EVENTS

    event UAVRegistered(address indexed uav, uint256 capacityMax);
    event MissionStarted();
    event HeartbeatReceived(address indexed uav, uint256 timestamp);
    event TaskCreated(uint256 indexed taskId, address indexed assignedTo);
    event TaskCompleted(uint256 indexed taskId);
    event FailureDetected(address indexed suspect, ReasonCode reason, bytes32 evidenceHash, uint256 timestamp);
    event VoteCast(address indexed voter, address indexed suspect, VoteChoice vote);
    event SuspectConfirmedFailed(address indexed suspect);
    event SuspectConfirmedByzantine(address indexed suspect);
    event SuspectRejected(address indexed suspect);
    event UAVRemoved(address indexed uav);
    event TaskReassigned(uint256 indexed taskId, address indexed fromUav, address indexed toUav);
    event TaskUnassigned(uint256 indexed taskId);
    event MissionDegraded(FormationMode formationMode);
    event MissionCompleted();
    event MissionAborted(string reason);
    event MissionReset(uint256 timestamp);
    event ContractUpgraded(address indexed newImpl, uint256 timestamp);

    // MODIFIERS

    modifier onlyRegisteredOperationalUAV() {
        require(uavs[msg.sender].registered,   "UAV not registered");
        require(uavs[msg.sender].operational,  "UAV not operational");
        _;
    }

    // CONSTRUCTOR + INITIALIZER

    constructor() {
        _disableInitializers();
    }

    function initialize(
        address       _authority,
        uint256       _heartbeatTimeoutSec,
        uint256       _quorumThreshold,
        uint256       _abortFailureThreshold,
        uint256       _degradedCapacityThreshold,
        FormationMode _formationMode
    ) public initializer {
        require(_authority != address(0),   "Invalid authority");
        require(_quorumThreshold > 0,       "Quorum must be > 0");
        require(_abortFailureThreshold > 0, "Abort threshold must be > 0");

        __Ownable_init(_authority);

        heartbeatTimeoutSec       = _heartbeatTimeoutSec;
        quorumThreshold           = _quorumThreshold;
        abortFailureThreshold     = _abortFailureThreshold;
        degradedCapacityThreshold = _degradedCapacityThreshold;
        formationMode             = _formationMode;
    }

    // SETUP

    function registerUAV(address _uav, uint256 _capacityMax) external onlyOwner {
        require(!missionActive,         "Mission already started");
        require(_uav != address(0),     "Invalid UAV");
        require(!uavs[_uav].registered, "Already registered");
        require(_capacityMax > 0,       "Capacity must be > 0");

        uavs[_uav] = UAV({
            registered:    true,
            operational:   true,
            lastHeartbeat: block.timestamp,
            capacityMax:   _capacityMax,
            loadCurrent:   0
        });
        uavList.push(_uav);
        emit UAVRegistered(_uav, _capacityMax);
    }

    function createTask(uint256 taskId, address assignedTo) external onlyOwner {
        require(!missionActive,                                             "Mission already started");
        require(uavs[assignedTo].registered,                                "Assigned UAV not registered");
        require(uavs[assignedTo].operational,                               "Assigned UAV not operational");
        require(!tasks[taskId].active,                                      "Task already exists");
        require(uavs[assignedTo].loadCurrent < uavs[assignedTo].capacityMax, "UAV at full capacity");

        tasks[taskId] = Task({ id: taskId, assignedTo: assignedTo, active: true });
        activeTaskIds.push(taskId);
        uavs[assignedTo].loadCurrent += 1;
        emit TaskCreated(taskId, assignedTo);
    }

    function startMission() external onlyOwner {
        require(!missionActive && !missionCompleted && !aborted, "Mission already started or finished");
        require(uavList.length > 0,       "No UAVs registered");
        require(activeTaskIds.length > 0, "No tasks created");

        for (uint256 i = 0; i < uavList.length; i++) {
            uavs[uavList[i]].lastHeartbeat = block.timestamp;
        }
        missionActive = true;
        emit MissionStarted();
    }

    // RUNTIME

    function heartbeat() external onlyRegisteredOperationalUAV {
        require(missionActive, "Mission not active");
        uavs[msg.sender].lastHeartbeat = block.timestamp;
        emit HeartbeatReceived(msg.sender, block.timestamp);
    }

    function detectMissingHeartbeat(address _suspect, bytes32 _evidenceHash)
        external virtual onlyOwner
    {
        require(missionActive,          "Mission not active");
        require(suspectUav == address(0), "Incident already open");
        require(uavs[_suspect].registered && uavs[_suspect].operational, "Suspect not eligible");
        require(
            block.timestamp > uavs[_suspect].lastHeartbeat + heartbeatTimeoutSec,
            "Heartbeat timeout not reached"
        );
        _openIncident(_suspect, ReasonCode.NO_HEARTBEAT, _evidenceHash);
    }

    function openBehaviorIncident(address _suspect, bytes32 _evidenceHash) external onlyOwner {
        require(missionActive,            "Mission not active");
        require(suspectUav == address(0), "Incident already open");
        require(uavs[_suspect].registered && uavs[_suspect].operational, "Suspect not eligible");
        _openIncident(_suspect, ReasonCode.MALICIOUS_BEHAVIOR, _evidenceHash);
    }

    function voteOnSuspect(VoteChoice vote) external onlyRegisteredOperationalUAV {
        require(suspectUav != address(0),               "No incident open");
        require(msg.sender != suspectUav,                "Suspect cannot vote");
        require(!hasVotedOnCurrentIncident[msg.sender],  "Already voted");
        require(
            vote == VoteChoice.CONFIRM_FAILED ||
            vote == VoteChoice.CONFIRM_BYZANTINE ||
            vote == VoteChoice.REJECT,
            "Invalid vote"
        );

        hasVotedOnCurrentIncident[msg.sender] = true;

        if      (vote == VoteChoice.CONFIRM_FAILED)    votesForFailed    += 1;
        else if (vote == VoteChoice.CONFIRM_BYZANTINE) votesForByzantine += 1;
        else                                            votesReject       += 1;

        emit VoteCast(msg.sender, suspectUav, vote);
    }

    function finalizeIncident() external virtual onlyOwner {
        require(suspectUav != address(0),   "No incident open");
        require(!reconfigurationPending,    "Reconfiguration already pending");

        uint256 eligible       = getActiveEligibleVoters();
        bool    quorumPossible = eligible >= quorumThreshold;

        bool decideFailed    = votesForFailed    >= quorumThreshold ||
                               (!quorumPossible && votesForFailed    == eligible && eligible > 0);
        bool decideByzantine = votesForByzantine >= quorumThreshold ||
                               (!quorumPossible && votesForByzantine == eligible && eligible > 0);
        bool decideReject    = votesReject       >= quorumThreshold ||
                               (!quorumPossible && votesReject       == eligible && eligible > 0);

        if (decideFailed) {
            uavs[suspectUav].operational = false;
            reconfigurationPending       = true;
            emit SuspectConfirmedFailed(suspectUav);
        } else if (decideByzantine) {
            uavs[suspectUav].operational = false;
            reconfigurationPending       = true;
            emit SuspectConfirmedByzantine(suspectUav);
        } else if (decideReject) {
            emit SuspectRejected(suspectUav);
            _clearIncident();
        } else {
            revert("Quorum not reached");
        }
    }

    function triggerReconfiguration() external virtual onlyOwner {
        require(reconfigurationPending, "No reconfiguration pending");

        address suspect = suspectUav;
        _removeUAVAndReassignTasks(suspect);
        failureCount           += 1;
        reconfigurationPending  = false;

        if (failureCount >= abortFailureThreshold) {
            aborted       = true;
            missionActive = false;
            emit MissionAborted("Failure threshold exceeded");
            _clearIncident();
            return;
        }

        if (_totalResidualCapacity() == 0 && _hasUnassignedTasks()) {
            aborted       = true;
            missionActive = false;
            emit MissionAborted("No residual capacity to continue");
            _clearIncident();
            return;
        }

        if (_currentOperationalCapacity() >= degradedCapacityThreshold && !_hasUnassignedTasks()) {
            degraded = false;
        } else {
            degraded = true;
            emit MissionDegraded(formationMode);
        }

        _clearIncident();
    }

    function completeTask(uint256 taskId) external onlyOwner {
        require(tasks[taskId].active, "Task not active");
        address assignedTo = tasks[taskId].assignedTo;
        tasks[taskId].active = false;
        if (assignedTo != address(0) && uavs[assignedTo].registered) {
            if (uavs[assignedTo].loadCurrent > 0) uavs[assignedTo].loadCurrent -= 1;
        }
        _removeFromActiveTaskIds(taskId);
        emit TaskCompleted(taskId);
    }

    function completeMission() external onlyOwner {
        require(missionActive, "Mission not active");
        require(!aborted,      "Mission aborted");
        missionActive    = false;
        missionCompleted = true;
        emit MissionCompleted();
    }

    function abortMission(string calldata reason) external onlyOwner {
        require(!aborted && !missionCompleted, "Already terminal");
        aborted       = true;
        missionActive = false;
        emit MissionAborted(reason);
    }

    function resetMission() public virtual onlyOwner {
        require(missionActive || missionCompleted || aborted, "Mission already in setup");

        for (uint256 i = 0; i < uavList.length; i++) {
            _clearUAVData(uavList[i]);
        }
        delete uavList;

        for (uint256 i = 0; i < activeTaskIds.length; i++) {
            delete tasks[activeTaskIds[i]];
        }
        delete activeTaskIds;

        suspectUav              = address(0);
        currentReason           = ReasonCode.NONE;
        currentEvidenceHash     = bytes32(0);
        incidentTimestamp       = 0;
        votesForFailed          = 0;
        votesForByzantine       = 0;
        votesReject             = 0;
        failureCount            = 0;
        reconfigurationPending  = false;

        missionActive    = false;
        missionCompleted = false;
        aborted          = false;
        degraded         = false;

        emit MissionReset(block.timestamp);
    }

    // VIEW FUNCTIONS

    function version() external pure virtual returns (string memory) {
        return "V1";
    }

    function getUAVCount() external view returns (uint256) {
        return uavList.length;
    }

    function getActiveTaskCount() external view returns (uint256 count) {
        for (uint256 i = 0; i < activeTaskIds.length; i++) {
            if (tasks[activeTaskIds[i]].active) count++;
        }
    }

    function getActiveEligibleVoters() public view returns (uint256 count) {
        for (uint256 i = 0; i < uavList.length; i++) {
            address u = uavList[i];
            if (uavs[u].operational && u != suspectUav) count++;
        }
    }

    function getResidualCapacity(address _uav) public view returns (uint256) {
        UAV memory u = uavs[_uav];
        if (!u.registered || !u.operational) return 0;
        if (u.capacityMax <= u.loadCurrent) return 0;
        return u.capacityMax - u.loadCurrent;
    }

    function getTaskSummary(uint256 taskId)
        external view
        returns (bool active, address assignedTo, uint256 assigneeLoad, uint256 assigneeCapacity)
    {
        Task memory t = tasks[taskId];
        active     = t.active;
        assignedTo = t.assignedTo;
        if (t.assignedTo != address(0) && uavs[t.assignedTo].registered) {
            assigneeLoad     = uavs[t.assignedTo].loadCurrent;
            assigneeCapacity = uavs[t.assignedTo].capacityMax;
        }
    }

    function getMissionSummary()
        external view
        returns (
            bool       active,
            bool       completed,
            bool       abortedFlag,
            bool       degradedFlag,
            uint256    failures,
            uint256    activeUAVs,
            uint256    activeTasks,
            address    suspect,
            ReasonCode reason,
            uint256    vFailed,
            uint256    vByzantine,
            uint256    vReject
        )
    {
        uint256 uavCnt;
        for (uint256 i = 0; i < uavList.length; i++) {
            if (uavs[uavList[i]].operational) uavCnt++;
        }
        uint256 taskCnt;
        for (uint256 i = 0; i < activeTaskIds.length; i++) {
            if (tasks[activeTaskIds[i]].active) taskCnt++;
        }
        return (
            missionActive, missionCompleted, aborted, degraded,
            failureCount, uavCnt, taskCnt, suspectUav,
            currentReason, votesForFailed, votesForByzantine, votesReject
        );
    }

    // INTERNAL FUNCTIONS

    function _openIncident(address _suspect, ReasonCode _reason, bytes32 _evidenceHash) internal {
        suspectUav          = _suspect;
        currentReason       = _reason;
        currentEvidenceHash = _evidenceHash;
        incidentTimestamp   = block.timestamp;
        _resetVotes();
        emit FailureDetected(_suspect, _reason, _evidenceHash, block.timestamp);
    }

    function _removeUAVAndReassignTasks(address _removedUav) internal {
        for (uint256 i = 0; i < activeTaskIds.length; i++) {
            uint256 taskId = activeTaskIds[i];
            if (tasks[taskId].active && tasks[taskId].assignedTo == _removedUav) {
                address newUav = _findBestReplacementUAV(_removedUav);
                if (newUav != address(0)) {
                    tasks[taskId].assignedTo  = newUav;
                    uavs[newUav].loadCurrent += 1;
                    emit TaskReassigned(taskId, _removedUav, newUav);
                } else {
                    tasks[taskId].assignedTo = address(0);
                    emit TaskUnassigned(taskId);
                }
            }
        }
        uavs[_removedUav].loadCurrent = 0;
        emit UAVRemoved(_removedUav);
    }

    function _findBestReplacementUAV(address _excluded) internal view returns (address bestUav) {
        uint256 bestResidual = 0;
        for (uint256 i = 0; i < uavList.length; i++) {
            address candidate = uavList[i];
            if (candidate == _excluded) continue;
            if (!uavs[candidate].operational) continue;
            uint256 residual = getResidualCapacity(candidate);
            if (residual > bestResidual) {
                bestResidual = residual;
                bestUav      = candidate;
            }
        }
    }

    function _totalResidualCapacity() internal view returns (uint256 total) {
        for (uint256 i = 0; i < uavList.length; i++) {
            total += getResidualCapacity(uavList[i]);
        }
    }

    function _currentOperationalCapacity() internal view returns (uint256 total) {
        for (uint256 i = 0; i < uavList.length; i++) {
            address u = uavList[i];
            if (uavs[u].operational) total += uavs[u].capacityMax;
        }
    }

    function _hasUnassignedTasks() internal view returns (bool) {
        for (uint256 i = 0; i < activeTaskIds.length; i++) {
            uint256 taskId = activeTaskIds[i];
            if (tasks[taskId].active && tasks[taskId].assignedTo == address(0)) return true;
        }
        return false;
    }

    function _resetVotes() internal {
        for (uint256 i = 0; i < uavList.length; i++) {
            hasVotedOnCurrentIncident[uavList[i]] = false;
        }
        votesForFailed    = 0;
        votesForByzantine = 0;
        votesReject       = 0;
    }

    function _clearIncident() internal {
        for (uint256 i = 0; i < uavList.length; i++) {
            hasVotedOnCurrentIncident[uavList[i]] = false;
        }
        suspectUav          = address(0);
        currentReason       = ReasonCode.NONE;
        currentEvidenceHash = bytes32(0);
        incidentTimestamp   = 0;
        votesForFailed       = 0;
        votesForByzantine   = 0;
        votesReject         = 0;
    }

    function _clearUAVData(address uav) internal virtual {
        uavs[uav].registered    = false;
        uavs[uav].operational   = false;
        uavs[uav].lastHeartbeat = 0;
        uavs[uav].capacityMax   = 0;
        uavs[uav].loadCurrent   = 0;
        hasVotedOnCurrentIncident[uav] = false;
    }

    function _removeFromActiveTaskIds(uint256 taskId) internal {
        for (uint256 i = 0; i < activeTaskIds.length; i++) {
            if (activeTaskIds[i] == taskId) {
                activeTaskIds[i] = activeTaskIds[activeTaskIds.length - 1];
                activeTaskIds.pop();
                return;
            }
        }
    }

    function _authorizeUpgrade(address newImpl)
        internal override onlyOwner
    {
        emit ContractUpgraded(newImpl, block.timestamp);
    }
}
