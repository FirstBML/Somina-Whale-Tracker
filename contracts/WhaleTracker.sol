// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title WhaleTracker
/// @notice Emits WhaleTransfer events for large token transfers.
///         Somnia Reactivity Engine pushes these events to WhaleHandler._onEvent()
contract WhaleTracker {
    event WhaleTransfer(
        address indexed from,
        address indexed to,
        uint256 amount,
        uint256 timestamp,
        string  token
    );

    event ThresholdUpdated(uint256 oldValue, uint256 newValue);

    address public owner;
    uint256 public threshold;

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(uint256 _threshold) {
        owner     = msg.sender;
        threshold = _threshold > 0 ? _threshold : 10_000 * 1e18;
    }

    /// @param from   Sender address
    /// @param to     Receiver address
    /// @param amount Amount in token base units (18 decimals)
    /// @param token  Token symbol e.g. "STT", "USDC", "WETH"
    function reportTransfer(
        address from,
        address to,
        uint256 amount,
        string calldata token
    ) external {
        require(amount >= threshold, "Below whale threshold");
        emit WhaleTransfer(from, to, amount, block.timestamp, token);
    }

    function setThreshold(uint256 _threshold) external onlyOwner {
        emit ThresholdUpdated(threshold, _threshold);
        threshold = _threshold;
    }
}