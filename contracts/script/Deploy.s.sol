// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {JobForwarder} from "../src/JobForwarder.sol";

/// Legacy JobForwarder deployment. New hires use PrimePortEscrow.
///   forge script script/Deploy.s.sol --rpc-url <rpc> \
///     --broadcast --private-key $DEPLOYER_KEY
/// Env:
///   USDT_ADDRESS   settlement token
///   REGISTRAR      backend wallet that registers hires
contract Deploy is Script {
    function run() external {
        address usdt = vm.envAddress("USDT_ADDRESS");
        address registrar = vm.envAddress("REGISTRAR");
        vm.startBroadcast();
        JobForwarder fwd = new JobForwarder(usdt, registrar);
        vm.stopBroadcast();
        console.log("JobForwarder:", address(fwd));
    }
}
