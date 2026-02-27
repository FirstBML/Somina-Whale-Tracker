// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title WhaleTracker - Emits events for large on-chain transfers
contract WhaleTracker {
    uint256 public constant WHALE_THRESHOLD = 10_000 * 1e18;

    event WhaleTransfer(
        address indexed from,
        address indexed to,
        uint256 amount,
        uint256 timestamp
    );

    event ThresholdUpdated(uint256 oldValue, uint256 newValue);

    address public owner;
    uint256 public threshold;

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(uint256 _threshold) {
        owner = msg.sender;
        threshold = _threshold > 0 ? _threshold : WHALE_THRESHOLD;
    }

    /// @notice Report a large transfer — Somnia Reactivity will push this event to subscribers
    function reportTransfer(address from, address to, uint256 amount) external {
        require(amount >= threshold, "Below whale threshold");
        emit WhaleTransfer(from, to, amount, block.timestamp);
    }

    function setThreshold(uint256 _threshold) external onlyOwner {
        emit ThresholdUpdated(threshold, _threshold);
        threshold = _threshold;
    }
}