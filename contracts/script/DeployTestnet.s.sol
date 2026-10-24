// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PrimePortEscrow} from "../src/PrimePortEscrow.sol";
import {TestUSD} from "../src/TestUSD.sol";

/// Deploy the standalone testnet stack: a 6-decimal test USD plus the escrow
/// that holds the negotiated wage in it.
///
/// Robinhood Chain Testnet (46630):
///   RESOLVER_ADDRESS=$RESOLVER MINT_TO=$MINT_TO \
///   forge script script/DeployTestnet.s.sol \
///     --rpc-url https://rpc.testnet.chain.robinhood.com \
///     --broadcast --private-key $DEPLOYER_KEY
///
/// Env:
///   RESOLVER_ADDRESS  the address allowed to apply a dispute split. On a
///                     pure testnet an EOA you control is enough; the GenLayer
///                     relay may be pointed at this escrow later.
///   MINT_TO           the address that receives the opening test USD balance.
///   MINT_AMOUNT       whole test USD to mint, default 100000 (6 decimals).
contract DeployTestnet is Script {
    function run() external {
        address resolver = vm.envAddress("RESOLVER_ADDRESS");
        address mintTo = vm.envAddress("MINT_TO");
        uint256 mintAmount = vm.envOr("MINT_AMOUNT", uint256(100_000)) * 1e6;

        vm.startBroadcast();
        TestUSD usd = new TestUSD();
        usd.mint(mintTo, mintAmount);
        PrimePortEscrow escrow = new PrimePortEscrow(address(usd), resolver);
        vm.stopBroadcast();

        console.log("TestUSD:", address(usd));
        console.log("PrimePortEscrow:", address(escrow));
        console.log("Resolver:", resolver);
        console.log("Minted to:", mintTo);
        console.log("");
        console.log("Set these on the backend:");
        console.log("  ESCROW_ADDRESS=%s", address(escrow));
        console.log("  USDT_ADDRESS=%s", address(usd));
        console.log("  ESCROW_CHAIN_ID=46630");
        console.log("  ESCROW_RPC_URL=https://rpc.testnet.chain.robinhood.com");
    }
}
