// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PrimePortEscrow} from "../src/PrimePortEscrow.sol";

/// Env:
///   USDT_ADDRESS     settlement token (USDC/USDG, or TestUSD on a testnet)
///   RESOLVER_ADDRESS trusted GenLayer bridge receiver; immutable
contract DeployEscrow is Script {
    function run() external {
        address usdt = vm.envAddress("USDT_ADDRESS");
        address resolver = vm.envAddress("RESOLVER_ADDRESS");
        vm.startBroadcast();
        PrimePortEscrow escrow = new PrimePortEscrow(usdt, resolver);
        vm.stopBroadcast();
        console.log("PrimePortEscrow:", address(escrow));
    }
}
