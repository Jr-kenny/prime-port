// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PrimePortEscrow} from "../src/PrimePortEscrow.sol";

/// Env:
///   USDT_ADDRESS     USD₮0 on X Layer
///   RESOLVER_ADDRESS trusted GenLayer bridge receiver on X Layer
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
