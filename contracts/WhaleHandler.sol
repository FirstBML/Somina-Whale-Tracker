// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { SomniaEventHandler } from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";

/// @title WhaleHandler
/// @notice On-chain reactive handler for WhaleTransfer events.
///         Somnia Reactivity Engine calls _onEvent() for every matching WhaleTransfer.
///         This proves Phase 2: true on-chain reactivity — not just a WebSocket listener.
contract WhaleHandler is SomniaEventHandler {

    // ── Events ────────────────────────────────────────────────────────────────

    /// @notice Fired every time the Reactivity Engine calls this handler
    event ReactedToWhaleTransfer(
        address indexed emitter,    // WhaleTracker contract address
        bytes32         topic0,     // WhaleTransfer event signature hash
        address         from,       // decoded from topic1
        address         to,         // decoded from topic2
        uint256         count       // cumulative reactions
    );

    /// @notice Fired when a large alert threshold is crossed
    event AlertThresholdCrossed(uint256 reactionCount, uint256 blockNumber);

    // ── State ─────────────────────────────────────────────────────────────────

    address public immutable owner;
    address public whaleTrackerAddress;   // set after WhaleTracker deploys
    uint256 public reactionCount;
    uint256 public alertEvery;            // emit AlertThresholdCrossed every N reactions

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _whaleTracker, uint256 _alertEvery) {
        owner              = msg.sender;
        whaleTrackerAddress = _whaleTracker;
        alertEvery         = _alertEvery > 0 ? _alertEvery : 5;
    }

    // ── Handler ───────────────────────────────────────────────────────────────

    /// @notice Called by Somnia Reactivity Engine for every matching WhaleTransfer event.
    ///         msg.sender == 0x0100 (Somnia Reactivity Precompile)
    ///         tx.origin  == subscription owner
    /// @param emitter      Address of WhaleTracker contract that emitted the event
    /// @param eventTopics  [topic0=WhaleTransfer sig, topic1=from, topic2=to]
    /// @param data         ABI-encoded (amount, timestamp, token)
    function _onEvent(
        address         emitter,
        bytes32[] calldata eventTopics,
        bytes     calldata data
    ) internal override {
        // Optional: guard against unexpected emitters
        // Uncomment after testing to restrict to WhaleTracker only:
        // require(emitter == whaleTrackerAddress, "Unknown emitter");

        reactionCount++;

        // Decode from / to from indexed topics
        address from = eventTopics.length > 1 ? address(uint160(uint256(eventTopics[1]))) : address(0);
        address to   = eventTopics.length > 2 ? address(uint160(uint256(eventTopics[2]))) : address(0);

        emit ReactedToWhaleTransfer(emitter, eventTopics[0], from, to, reactionCount);

        // Periodic alert every N reactions
        if (reactionCount % alertEvery == 0) {
            emit AlertThresholdCrossed(reactionCount, block.number);
        }
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setWhaleTracker(address _addr) external onlyOwner {
        whaleTrackerAddress = _addr;
    }

    function setAlertEvery(uint256 _n) external onlyOwner {
        require(_n > 0, "Must be > 0");
        alertEvery = _n;
    }
}
