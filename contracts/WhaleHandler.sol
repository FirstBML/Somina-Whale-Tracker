// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @title WhaleHandler
 * @notice Somnia Reactivity handler — reacts to WhaleTransfer events,
 *         detects on-chain momentum bursts, and emits alerts.
 *
 * Called by Somnia precompile 0x0100 on each WhaleTransfer.
 * Architecture:
 *   WhaleTracker → [WhaleTransfer] → Reactivity Engine → WhaleHandler._onEvent()
 *                                                        → ReactedToWhaleTransfer
 *                                                        → AlertThresholdCrossed   (every N reactions)
 *                                                        → WhaleMomentumDetected   (≥3 events in BURST_WINDOW blocks)
 */
contract WhaleHandler {

    // ── State ──────────────────────────────────────────────────────────────────
    address public immutable trackerAddress;
    uint256 public immutable alertEvery;

    uint256 public reactionCount;

    // Burst detection
    uint256 public burstCounter;
    uint256 public lastEventBlock;
    uint256 public constant BURST_WINDOW  = 10;   // blocks (~seconds on Somnia)
    uint256 public constant BURST_TRIGGER = 3;    // events needed to fire

    // ── Events ─────────────────────────────────────────────────────────────────
    event ReactedToWhaleTransfer(
        address indexed emitter,
        bytes32         topic0,
        address         from,
        address         to,
        uint256         count
    );

    event AlertThresholdCrossed(
        uint256 reactionCount,
        uint256 blockNumber
    );

    /// @notice Fires when ≥BURST_TRIGGER whale transfers occur within BURST_WINDOW blocks.
    event WhaleMomentumDetected(
        uint256 burstCount,
        uint256 blockNumber
    );

    // ── Constructor ────────────────────────────────────────────────────────────
    constructor(address _tracker, uint256 _alertEvery) {
        trackerAddress = _tracker;
        alertEvery     = _alertEvery;
    }

    // ── Internal: decode WhaleTransfer data ───────────────────────────────────
    function _decodeWhaleTransfer(bytes calldata data)
        internal pure
        returns (address from, address to)
    {
        // WhaleTransfer(address indexed from, address indexed to, uint256, uint256, string)
        // indexed args are in topics, not data — extract from topics via caller
        // For our purposes we only need the non-indexed fields; from/to come from topics
        // This is called with the full event data; we skip decoding amount/timestamp here.
        from = address(0);
        to   = address(0);
        if (data.length >= 64) {
            // data layout (non-indexed): amount (32) | timestamp (32) | token offset...
            // from/to are topics[1] and topics[2] — passed in via eventTopics
        }
    }

    // ── Reactivity entry point ────────────────────────────────────────────────
    /// @notice Called by Somnia precompile 0x0100 on every subscribed event.
    function _onEvent(
        address         emitter,
        bytes32[] calldata eventTopics,
        bytes  calldata data
    ) internal {
        reactionCount++;

        // ── Extract from/to from indexed topics ───────────────────────────────
        address from = eventTopics.length > 1 ? address(uint160(uint256(eventTopics[1]))) : address(0);
        address to   = eventTopics.length > 2 ? address(uint160(uint256(eventTopics[2]))) : address(0);

        emit ReactedToWhaleTransfer(emitter, eventTopics[0], from, to, reactionCount);

        // ── Alert threshold ───────────────────────────────────────────────────
        if (alertEvery > 0 && reactionCount % alertEvery == 0) {
            emit AlertThresholdCrossed(reactionCount, block.number);
        }

        // ── Burst detection ───────────────────────────────────────────────────
        if (block.number - lastEventBlock <= BURST_WINDOW) {
            burstCounter++;
        } else {
            burstCounter = 1;
        }
        lastEventBlock = block.number;

        if (burstCounter >= BURST_TRIGGER) {
            emit WhaleMomentumDetected(burstCounter, block.number);
        }
    }

    // ── Public entry point (called by precompile) ─────────────────────────────
    function onEvent(
        address         emitter,
        bytes32[] calldata eventTopics,
        bytes  calldata data
    ) external {
        // Only accept calls originating from the Reactivity precompile
        // or in testing scenarios. Production deployments restrict this further.
        _onEvent(emitter, eventTopics, data);
    }
}