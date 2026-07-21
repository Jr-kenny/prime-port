// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PrimePortEscrow} from "../src/PrimePortEscrow.sol";

contract EscrowMockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public returnsBool = true;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setReturnsBool(bool value) external {
        returnsBool = value;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        if (!returnsBool) assembly { return(0, 0) }
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        if (!returnsBool) assembly { return(0, 0) }
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract PrimePortEscrowTest is Test {
    EscrowMockToken token;
    PrimePortEscrow escrow;

    uint256 buyerKey = 0xB0B;
    uint256 providerKey = 0xA11CE;
    address buyer;
    address provider;
    address payout = makeAddr("payout");
    address resolver = makeAddr("genlayer-bridge-receiver");
    address stranger = makeAddr("stranger");

    bytes32 constant COMMITMENT = keccak256("prime-port-job-1");
    uint256 constant AMOUNT = 40e6;
    uint64 deadline;

    function setUp() public {
        buyer = vm.addr(buyerKey);
        provider = vm.addr(providerKey);
        token = new EscrowMockToken();
        escrow = new PrimePortEscrow(address(token), resolver);
        deadline = uint64(block.timestamp + 7 days);
        token.mint(buyer, 1_000e6);
        vm.prank(buyer);
        token.approve(address(escrow), type(uint256).max);
    }

    function test_fund_verifiesBothSignaturesAndLocksFunds() public {
        _fund();
        (
            address storedBuyer,
            address storedProvider,
            address storedPayout,
            uint256 storedAmount,
            uint64 storedDeadline,
            PrimePortEscrow.State state,
            PrimePortEscrow.Outcome outcome,,
        ) = escrow.escrows(COMMITMENT);
        assertEq(storedBuyer, buyer);
        assertEq(storedProvider, provider);
        assertEq(storedPayout, payout);
        assertEq(storedAmount, AMOUNT);
        assertEq(storedDeadline, deadline);
        assertEq(uint8(state), uint8(PrimePortEscrow.State.Funded));
        assertEq(uint8(outcome), uint8(PrimePortEscrow.Outcome.None));
        assertEq(token.balanceOf(address(escrow)), AMOUNT);
    }

    function test_fund_rejectsTamperedPayout() public {
        (bytes memory buyerSig, bytes memory providerSig) = _sign(COMMITMENT, payout, AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(PrimePortEscrow.InvalidSignature.selector, buyer));
        escrow.fund(COMMITMENT, buyer, provider, stranger, AMOUNT, deadline, buyerSig, providerSig);
    }

    function test_fund_isWriteOnce() public {
        _fund();
        (bytes memory buyerSig, bytes memory providerSig) = _sign(COMMITMENT, payout, AMOUNT);
        vm.expectRevert(PrimePortEscrow.AlreadyExists.selector);
        escrow.fund(COMMITMENT, buyer, provider, payout, AMOUNT, deadline, buyerSig, providerSig);
    }

    function test_release_onlyBuyerPaysPayout() public {
        _fund();
        vm.prank(stranger);
        vm.expectRevert(PrimePortEscrow.NotBuyer.selector);
        escrow.release(COMMITMENT);

        vm.prank(buyer);
        escrow.release(COMMITMENT);
        assertEq(token.balanceOf(payout), AMOUNT);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_refund_onlyProviderPaysBuyer() public {
        _fund();
        uint256 buyerAfterFunding = token.balanceOf(buyer);
        vm.prank(provider);
        escrow.refund(COMMITMENT);
        assertEq(token.balanceOf(buyer), buyerAfterFunding + AMOUNT);
    }

    function test_disputeFreezesHappyPathAndResolverCanSplit() public {
        _fund();
        bytes32 evidence = keccak256("evidence-bundle");
        vm.prank(provider);
        escrow.openDispute(COMMITMENT, evidence);

        vm.prank(buyer);
        vm.expectRevert();
        escrow.release(COMMITMENT);

        bytes32 resolutionId = keccak256("genlayer-resolution-1");
        bytes32 verdictHash = keccak256("provider gets 75 percent");
        vm.prank(resolver);
        escrow.resolveDispute(COMMITMENT, resolutionId, verdictHash, 7_500);
        assertEq(token.balanceOf(payout), 30e6);
        assertEq(token.balanceOf(buyer), 970e6);
        assertTrue(escrow.usedResolutions(resolutionId));
    }

    function test_resolutionRejectsWrongCallerAndReplay() public {
        _fund();
        vm.prank(buyer);
        escrow.openDispute(COMMITMENT, keccak256("evidence"));
        bytes32 resolutionId = keccak256("resolution");

        vm.prank(stranger);
        vm.expectRevert(PrimePortEscrow.NotResolver.selector);
        escrow.resolveDispute(COMMITMENT, resolutionId, keccak256("verdict"), 5_000);

        vm.prank(resolver);
        escrow.resolveDispute(COMMITMENT, resolutionId, keccak256("verdict"), 5_000);
        vm.prank(resolver);
        vm.expectRevert(PrimePortEscrow.ResolutionAlreadyUsed.selector);
        escrow.resolveDispute(keccak256("another"), resolutionId, keccak256("verdict"), 5_000);
    }

    function test_worksWithUsdTStyleNoReturnValue() public {
        token.setReturnsBool(false);
        _fund();
        vm.prank(buyer);
        escrow.release(COMMITMENT);
        assertEq(token.balanceOf(payout), AMOUNT);
    }

    function test_signatureMessageIsStable() public view {
        bytes32 authHash = escrow.authorizationHash(COMMITMENT, buyer, provider, payout, AMOUNT, deadline);
        string memory expected = string.concat("Prime Port escrow authorization v1: ", vm.toString(authHash));
        assertEq(escrow.authorizationMessage(authHash), expected);
    }

    function _fund() private {
        (bytes memory buyerSig, bytes memory providerSig) = _sign(COMMITMENT, payout, AMOUNT);
        escrow.fund(COMMITMENT, buyer, provider, payout, AMOUNT, deadline, buyerSig, providerSig);
    }

    function _sign(bytes32 commitment, address signedPayout, uint256 signedAmount)
        private
        view
        returns (bytes memory buyerSig, bytes memory providerSig)
    {
        bytes32 authHash = escrow.authorizationHash(commitment, buyer, provider, signedPayout, signedAmount, deadline);
        bytes32 digest = escrow.signatureDigest(authHash);
        (uint8 buyerV, bytes32 buyerR, bytes32 buyerS) = vm.sign(buyerKey, digest);
        (uint8 providerV, bytes32 providerR, bytes32 providerS) = vm.sign(providerKey, digest);
        buyerSig = abi.encodePacked(buyerR, buyerS, buyerV);
        providerSig = abi.encodePacked(providerR, providerS, providerV);
    }
}
