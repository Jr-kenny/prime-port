// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {JobForwarder} from "../src/JobForwarder.sol";

/// Deploy to XLayer:
///   forge script script/Deploy.s.sol --rpc-url https://rpc.xlayer.tech \
///     --broadcast --private-key $DEPLOYER_KEY
/// Env:
///   USDT_ADDRESS   USDT on XLayer
///   REGISTRAR      backend wallet that registers hires (the ASP wallet)
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
