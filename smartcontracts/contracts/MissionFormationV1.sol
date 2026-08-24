// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title MissionFormationV1 — upgradeable UUPS UAV formation-keeping contract
/// @notice Model 2 counterpart to MissionFormation: same centroid/violation/
///         recovery behavior, but progress is tracked with independent boolean
///         flags instead of an FSM enum, since dynamism here comes from UUPS
///         upgrades, not state transitions.
/// @dev Storage layout is fixed from this version on — never reorder, remove, or
///      retype existing state variables in V2+, only append new ones.
contract MissionFormationV1 is Initializable, OwnableUpgradeable, UUPSUpgradeable {

    // ENUMS

    enum UAVState {
        OK,
        LATE,
        OUT_OF_FORMATION,
        INACTIVE
    }

    // STRUCTS

    struct UAVData {
        bool     registered;
        UAVState state;
        int256   x;
        int256   y;
        uint256  lastUpdate;
        uint256  violationCount;
    }

    struct FormationParams {
        uint256 formationId;
        uint256 dMinSq;
        uint256 dMaxSq;
        uint256 rMaxSq;
    }

    // STATE VARIABLES

    bool public missionActive;
    bool public missionCompleted;
    bool public aborted;
    bool public degraded;

    bool    public formationChangePending;
    uint256 public toleranceWindow;
    uint256 public maxViolations;
    uint256 public degradedThreshold;
    uint256 public transitionTime;
    uint256 public transitionEnd;
    uint256 public quorum;

    FormationParams public currentFormation;
    FormationParams public pendingFormation;

    address[] public uavList;
    mapping(address => UAVData) public uavs;

    int256 public centroidX;
    int256 public centroidY;

    mapping(address => uint256) public violationVotes;
    mapping(address => mapping(address => bool)) public hasVoted;

    mapping(address => uint256) public recoveryVotes;
    mapping(address => mapping(address => bool)) public hasVotedRecovery;

    // EVENTS

    event UAVRegistered(address indexed uav, int256 x, int256 y);
    event MissionStarted(uint256 timestamp);
    event PositionUpdated(address indexed uav, int256 x, int256 y, UAVState state);
    event UAVStateChanged(address indexed uav, UAVState oldState, UAVState newState);
    event LateUAVDetected(address indexed uav, uint256 lastUpdate);
    event CentroidUpdated(int256 x, int256 y);
    event FormationChangeInitiated(uint256 formationId, uint256 dMinSq, uint256 dMaxSq, uint256 rMaxSq, uint256 transitionEnd);
    event FormationChangeFinalized(uint256 formationId);
    event FormationConstraintsUpdated(uint256 dMinSq, uint256 dMaxSq, uint256 rMaxSq);
    event DegradedStatusChanged(bool degraded);
    event UAVDeactivated(address indexed uav);
    event MissionCompleted();
    event MissionAborted(string reason);
    event MissionReset(uint256 timestamp);
    event ContractUpgraded(address indexed newImpl, uint256 timestamp);

    event ViolationReported(address indexed reporter, address indexed accused, uint256 votesNow, uint256 quorumNeeded);
    event ViolationConfirmed(address indexed accused, uint256 newViolationCount);
    event FormationViolation(address indexed uav, string reason);
    event RecoveryReported(address indexed reporter, address indexed uav, uint256 votesNow, uint256 quorumNeeded);
    event RecoveryConfirmed(address indexed uav);

    // MODIFIERS

    modifier onlySetup() {
        require(!missionActive, "Mission already started");
        _;
    }

    modifier inOperationalState() {
        require(missionActive && !missionCompleted && !aborted, "Mission not operational");
        _;
    }

    modifier onlyRegisteredActiveUAV() {
        require(uavs[msg.sender].registered, "UAV not registered");
        require(uavs[msg.sender].state != UAVState.INACTIVE, "UAV inactive");
        _;
    }

    constructor() { _disableInitializers(); }

    function initialize(
        address _owner,
        uint256 _toleranceWindow,
        uint256 _maxViolations,
        uint256 _degradedThreshold,
        uint256 _transitionTime,
        uint256 _quorum,
        uint256 _formationId,
        uint256 _dMinSq,
        uint256 _dMaxSq,
        uint256 _rMaxSq
    ) public initializer {
        require(_dMinSq < _dMaxSq,          "dMinSq must be < dMaxSq");
        require(_maxViolations > 0,         "maxViolations must be > 0");
        require(_degradedThreshold > 0,     "degradedThreshold must be > 0");
        require(_quorum > 0,                "quorum must be > 0");

        __Ownable_init(_owner);

        toleranceWindow   = _toleranceWindow;
        maxViolations     = _maxViolations;
        degradedThreshold = _degradedThreshold;
        transitionTime    = _transitionTime;
        quorum            = _quorum;

        currentFormation = FormationParams({
            formationId : _formationId,
            dMinSq      : _dMinSq,
            dMaxSq      : _dMaxSq,
            rMaxSq      : _rMaxSq
        });
    }

    function _authorizeUpgrade(address newImpl) internal override onlyOwner {
        emit ContractUpgraded(newImpl, block.timestamp);
    }

    // AUTHORITY SETUP

    function registerUAV(address _uav, int256 _x, int256 _y)
        external onlyOwner onlySetup
    {
        require(_uav != address(0),      "Invalid UAV");
        require(!uavs[_uav].registered,  "Already registered");

        uavs[_uav] = UAVData({
            registered    : true,
            state         : UAVState.OK,
            x             : _x,
            y             : _y,
            lastUpdate    : block.timestamp,
            violationCount: 0
        });

        uavList.push(_uav);
        emit UAVRegistered(_uav, _x, _y);
    }

    function startMission()
        external onlyOwner onlySetup
    {
        require(uavList.length >= 2,     "Need at least 2 UAVs");
        require(uavList.length > quorum, "quorum must be < number of UAVs");

        for (uint256 i = 0; i < uavList.length; i++) {
            uavs[uavList[i]].lastUpdate = block.timestamp;
        }

        _updateCentroid();
        missionActive = true;
        emit MissionStarted(block.timestamp);
    }

    // AUTHORITY RUNTIME

    function changeFormation(uint256 _formationId, uint256 _dMinSq, uint256 _dMaxSq, uint256 _rMaxSq)
        external onlyOwner inOperationalState
    {
        require(_dMinSq < _dMaxSq, "dMinSq must be < dMaxSq");

        pendingFormation       = FormationParams(_formationId, _dMinSq, _dMaxSq, _rMaxSq);
        transitionEnd          = block.timestamp + transitionTime;
        formationChangePending = true;

        emit FormationChangeInitiated(_formationId, _dMinSq, _dMaxSq, _rMaxSq, transitionEnd);
    }

    function finalizeFormationChange() external onlyOwner {
        require(formationChangePending, "No pending formation change");
        require(block.timestamp >= transitionEnd, "Transition period not ended");
        _applyFormationChange();
    }

    function updateFormationConstraints(uint256 _dMinSq, uint256 _dMaxSq, uint256 _rMaxSq)
        external onlyOwner inOperationalState
    {
        require(_dMinSq < _dMaxSq, "dMinSq must be < dMaxSq");
        currentFormation.dMinSq = _dMinSq;
        currentFormation.dMaxSq = _dMaxSq;
        currentFormation.rMaxSq = _rMaxSq;
        emit FormationConstraintsUpdated(_dMinSq, _dMaxSq, _rMaxSq);
    }

    function checkLateUAVs() external onlyOwner inOperationalState {
        for (uint256 i = 0; i < uavList.length; i++) {
            address u = uavList[i];
            UAVData storage uav = uavs[u];
            if (uav.state == UAVState.INACTIVE) continue;
            if (block.timestamp <= uav.lastUpdate + toleranceWindow) continue;
            if (uav.state == UAVState.OK) {
                UAVState old = uav.state;
                uav.state    = UAVState.LATE;
                emit UAVStateChanged(u, old, UAVState.LATE);
                emit LateUAVDetected(u, uav.lastUpdate);
            }
        }
        _checkSwarmHealth();
    }

    function deactivateUAV(address _uav) external onlyOwner {
        require(uavs[_uav].registered,                 "UAV not registered");
        require(uavs[_uav].state != UAVState.INACTIVE,  "Already inactive");

        UAVState old      = uavs[_uav].state;
        uavs[_uav].state  = UAVState.INACTIVE;
        _clearAllVotes(_uav);

        _updateCentroid();
        _checkSwarmHealth();

        emit UAVStateChanged(_uav, old, UAVState.INACTIVE);
        emit UAVDeactivated(_uav);
    }

    function completeMission() external onlyOwner {
        require(
            missionActive && !missionCompleted && !aborted && !formationChangePending,
            "Cannot complete in current state"
        );
        missionCompleted = true;
        emit MissionCompleted();
    }

    function abortMission(string calldata reason) external onlyOwner {
        require(!missionCompleted && !aborted, "Already terminal");
        aborted = true;
        emit MissionAborted(reason);
    }

    function resetMission() external virtual onlyOwner {
        require(missionActive || missionCompleted || aborted, "Already in setup");

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

        emit MissionReset(block.timestamp);
    }

    // UAV POSITION

    function updatePosition(int256 _x, int256 _y)
        external onlyRegisteredActiveUAV inOperationalState
    {
        UAVData storage uav = uavs[msg.sender];

        uav.x          = _x;
        uav.y          = _y;
        uav.lastUpdate = block.timestamp;

        if (formationChangePending && block.timestamp >= transitionEnd) {
            _applyFormationChange();
        }

        _updateCentroid();
        _clearAllVotes(msg.sender);

        UAVState newState = uav.state;
        if (uav.state == UAVState.LATE) {
            uav.violationCount = 0;
            newState = UAVState.OK;
        }

        if (newState != uav.state) {
            UAVState old = uav.state;
            uav.state    = newState;
            emit UAVStateChanged(msg.sender, old, newState);
        }

        emit PositionUpdated(msg.sender, _x, _y, uav.state);
        _checkSwarmHealth();
    }

    // UAV VIOLATION QUORUM

    function reportViolation(address _violator)
        external onlyRegisteredActiveUAV inOperationalState
    {
        require(uavs[_violator].registered,                 "Violator not registered");
        require(uavs[_violator].state != UAVState.INACTIVE, "Violator is inactive");
        require(_violator != msg.sender,                    "Cannot report yourself");
        require(!hasVoted[msg.sender][_violator],           "Already voted this round");

        hasVoted[msg.sender][_violator] = true;
        violationVotes[_violator]++;

        emit ViolationReported(msg.sender, _violator, violationVotes[_violator], quorum);

        if (violationVotes[_violator] >= quorum) {
            _clearViolationVotes(_violator);

            UAVData storage accused = uavs[_violator];
            accused.violationCount++;

            emit ViolationConfirmed(_violator, accused.violationCount);

            if (accused.violationCount >= maxViolations &&
                accused.state != UAVState.OUT_OF_FORMATION) {
                UAVState old  = accused.state;
                accused.state = UAVState.OUT_OF_FORMATION;
                emit UAVStateChanged(_violator, old, UAVState.OUT_OF_FORMATION);
                emit FormationViolation(_violator, "Consensus: quorum violation confirmed");
            }

            _checkSwarmHealth();
        }
    }

    // UAV RECOVERY QUORUM

    function reportRecovery(address _uav)
        external onlyRegisteredActiveUAV inOperationalState
    {
        require(uavs[_uav].registered,                          "UAV not registered");
        require(uavs[_uav].state == UAVState.OUT_OF_FORMATION,  "UAV not OUT_OF_FORMATION");
        require(_uav != msg.sender,                             "Cannot report yourself");
        require(!hasVotedRecovery[msg.sender][_uav],            "Already voted recovery this round");

        hasVotedRecovery[msg.sender][_uav] = true;
        recoveryVotes[_uav]++;

        emit RecoveryReported(msg.sender, _uav, recoveryVotes[_uav], quorum);

        if (recoveryVotes[_uav] >= quorum) {
            _clearRecoveryVotes(_uav);

            UAVData storage uav = uavs[_uav];
            UAVState old  = uav.state;
            uav.state     = UAVState.OK;
            uav.violationCount = 0;

            emit RecoveryConfirmed(_uav);
            emit UAVStateChanged(_uav, old, UAVState.OK);

            _checkSwarmHealth();
        }
    }

    // VIEW FUNCTIONS

    function getUAVCount() external view returns (uint256) {
        return uavList.length;
    }

    function getActiveUAVCount() public view returns (uint256 count) {
        for (uint256 i = 0; i < uavList.length; i++) {
            if (uavs[uavList[i]].state != UAVState.INACTIVE) count++;
        }
    }

    function getNonOKCount() public view returns (uint256 count) {
        for (uint256 i = 0; i < uavList.length; i++) {
            UAVState s = uavs[uavList[i]].state;
            if (s != UAVState.OK && s != UAVState.INACTIVE) count++;
        }
    }

    function getCentroid() external view returns (int256 x, int256 y) {
        return (centroidX, centroidY);
    }

    function getUAVStatus(address _uav)
        external view
        returns (
            UAVState state,
            int256   x,
            int256   y,
            uint256  lastUpdate,
            uint256  violationCount,
            uint256  distToCentroidSq,
            uint256  votes,
            uint256  recovVotes
        )
    {
        UAVData memory u = uavs[_uav];
        return (
            u.state,
            u.x,
            u.y,
            u.lastUpdate,
            u.violationCount,
            _squaredDist(u.x, u.y, centroidX, centroidY),
            violationVotes[_uav],
            recoveryVotes[_uav]
        );
    }

    function getSwarmSummary()
        external view
        returns (
            bool    active,
            bool    completed,
            bool    abortedFlag,
            bool    degradedFlag,
            uint256 formationId,
            int256  cx,
            int256  cy,
            uint256 totalUAVs,
            bool    inTransition,
            uint256 transitionSecsLeft
        )
    {
        bool    transition = formationChangePending && block.timestamp < transitionEnd;
        uint256 timeLeft   = transition ? transitionEnd - block.timestamp : 0;

        return (
            missionActive, missionCompleted, aborted, degraded,
            currentFormation.formationId, centroidX, centroidY,
            uavList.length, transition, timeLeft
        );
    }

    function getSwarmCounts()
        public view
        returns (
            uint256 okCount,
            uint256 lateCount,
            uint256 outOfFormationCount,
            uint256 inactiveCount
        )
    {
        for (uint256 i = 0; i < uavList.length; i++) {
            UAVState s = uavs[uavList[i]].state;
            if      (s == UAVState.OK)               okCount++;
            else if (s == UAVState.LATE)              lateCount++;
            else if (s == UAVState.OUT_OF_FORMATION)  outOfFormationCount++;
            else if (s == UAVState.INACTIVE)          inactiveCount++;
        }
    }

    function version() external pure virtual returns (string memory) { return "V1"; }

    // INTERNAL FUNCTIONS

    function _updateCentroid() internal {
        int256  sumX  = 0;
        int256  sumY  = 0;
        uint256 count = 0;

        for (uint256 i = 0; i < uavList.length; i++) {
            address u = uavList[i];
            if (uavs[u].state != UAVState.INACTIVE) {
                sumX  += uavs[u].x;
                sumY  += uavs[u].y;
                count++;
            }
        }

        if (count > 0) {
            centroidX = sumX / int256(count);
            centroidY = sumY / int256(count);
            emit CentroidUpdated(centroidX, centroidY);
        }
    }

    function _checkSwarmHealth() internal {
        if (formationChangePending && block.timestamp < transitionEnd) return;

        uint256 nonOK = getNonOKCount();

        if (nonOK >= degradedThreshold && !degraded) {
            degraded = true;
            emit DegradedStatusChanged(true);
        } else if (nonOK < degradedThreshold && degraded) {
            degraded = false;
            emit DegradedStatusChanged(false);
        }
    }

    function _applyFormationChange() internal {
        currentFormation = pendingFormation;

        for (uint256 i = 0; i < uavList.length; i++) {
            address u = uavList[i];
            uavs[u].violationCount = 0;
            _clearAllVotes(u);
        }

        formationChangePending = false;
        emit FormationChangeFinalized(currentFormation.formationId);
    }

    function _clearViolationVotes(address _uav) internal {
        violationVotes[_uav] = 0;
        for (uint256 i = 0; i < uavList.length; i++) {
            hasVoted[uavList[i]][_uav] = false;
        }
    }

    function _clearRecoveryVotes(address _uav) internal {
        recoveryVotes[_uav] = 0;
        for (uint256 i = 0; i < uavList.length; i++) {
            hasVotedRecovery[uavList[i]][_uav] = false;
        }
    }

    function _clearAllVotes(address _uav) internal {
        _clearViolationVotes(_uav);
        _clearRecoveryVotes(_uav);
    }

    function _squaredDist(int256 x1, int256 y1, int256 x2, int256 y2)
        internal pure returns (uint256)
    {
        int256 dx = x1 - x2;
        int256 dy = y1 - y2;
        return uint256(dx * dx + dy * dy);
    }
}
