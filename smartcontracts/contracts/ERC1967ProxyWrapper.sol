// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title ERC1967ProxyWrapper — compile-only wrapper
/// @notice No logic of its own; exists so Hardhat compiles OpenZeppelin's ERC1967Proxy.
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
