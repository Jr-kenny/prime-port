// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {JobForwarder} from "../src/JobForwarder.sol";

/// Standard ERC20-ish mock that returns bool, plus a USDT-style variant
/// that returns nothing, since XLayer USDT ancestry is Tether.
contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public returnsBool = true;

    function setReturnsBool(bool v) external { returnsBool = v; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        if (!returnsBool) _returnNothing();
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        if (!returnsBool) _returnNothing();
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }

    function _returnNothing() private pure {
        assembly { return(0, 0) }
    }
}

contract JobForwarderTest is Test {
    MockToken token;
    JobForwarder fwd;

    address registrar = makeAddr("registrar");
    address freelancer = makeAddr("freelancer");
    address watcher = makeAddr("watcher"); // the release watcher's wallet
    address stranger = makeAddr("stranger");

    bytes32 constant JOB = keccak256("job-1");

    function setUp() public {
        token = new MockToken();
        fwd = new JobForwarder(address(token), registrar);
        token.mint(watcher, 1_000e6);
        vm.prank(watcher);
        token.approve(address(fwd), type(uint256).max);
    }

    // --- register -----------------------------------------------------------

    function test_register_setsPayout() public {
        vm.prank(registrar);
        fwd.register(JOB, freelancer);
        assertEq(fwd.payoutOf(JOB), freelancer);
    }

    function test_register_rejectsNonRegistrar() public {
        vm.prank(stranger);
        vm.expectRevert(JobForwarder.NotRegistrar.selector);
        fwd.register(JOB, freelancer);
    }

    function test_register_rejectsZeroPayout() public {
        vm.prank(registrar);
        vm.expectRevert(JobForwarder.ZeroPayout.selector);
        fwd.register(JOB, address(0));
    }

    function test_register_isWriteOnce_evenForRegistrar() public {
        vm.startPrank(registrar);
        fwd.register(JOB, freelancer);
        vm.expectRevert(JobForwarder.AlreadyRegistered.selector);
        fwd.register(JOB, stranger);
        vm.stopPrank();
    }

    // --- deposit --------------------------------------------------------------

    function test_deposit_refusedUntilRegistered() public {
        vm.prank(watcher);
        vm.expectRevert(JobForwarder.UnregisteredJob.selector);
        fwd.deposit(JOB, 10e6);
    }

    function test_deposit_creditsJob() public {
        _register();
        vm.prank(watcher);
        fwd.deposit(JOB, 10e6);
        assertEq(fwd.balanceOf(JOB), 10e6);
        assertEq(token.balanceOf(address(fwd)), 10e6);
    }

    function test_deposit_rejectsZero() public {
        _register();
        vm.prank(watcher);
        vm.expectRevert(JobForwarder.ZeroAmount.selector);
        fwd.deposit(JOB, 0);
    }

    // --- forward ---------------------------------------------------------------

    function test_forward_paysRegisteredAddressInFull() public {
        _registerAndDeposit(10e6);
        vm.prank(stranger); // anyone can push the payment through
        fwd.forward(JOB);
        assertEq(token.balanceOf(freelancer), 10e6);
        assertEq(fwd.balanceOf(JOB), 0);
    }

    function test_forward_nothingToForwardTwice() public {
        _registerAndDeposit(10e6);
        fwd.forward(JOB);
        vm.expectRevert(JobForwarder.NothingToForward.selector);
        fwd.forward(JOB);
    }

    function test_forward_unregisteredJobReverts() public {
        vm.expectRevert(JobForwarder.UnregisteredJob.selector);
        fwd.forward(keccak256("never-registered"));
    }

    function test_forward_multipleDepositsAccumulate() public {
        _register();
        vm.startPrank(watcher);
        fwd.deposit(JOB, 3e6);
        fwd.deposit(JOB, 7e6);
        vm.stopPrank();
        fwd.forward(JOB);
        assertEq(token.balanceOf(freelancer), 10e6);
    }

    function test_jobsAreIsolated() public {
        bytes32 job2 = keccak256("job-2");
        address freelancer2 = makeAddr("freelancer2");
        vm.startPrank(registrar);
        fwd.register(JOB, freelancer);
        fwd.register(job2, freelancer2);
        vm.stopPrank();
        vm.startPrank(watcher);
        fwd.deposit(JOB, 4e6);
        fwd.deposit(job2, 6e6);
        vm.stopPrank();
        fwd.forward(job2);
        assertEq(token.balanceOf(freelancer2), 6e6);
        assertEq(token.balanceOf(freelancer), 0);
        assertEq(fwd.balanceOf(JOB), 4e6);
    }

    // --- USDT-style token (no return value) -------------------------------------

    function test_worksWithNonBoolReturningToken() public {
        token.setReturnsBool(false);
        _registerAndDeposit(10e6);
        fwd.forward(JOB);
        assertEq(token.balanceOf(freelancer), 10e6);
    }

    // --- events -------------------------------------------------------------------

    function test_events() public {
        vm.expectEmit(true, true, false, true);
        emit JobForwarder.Registered(JOB, freelancer);
        vm.prank(registrar);
        fwd.register(JOB, freelancer);

        vm.expectEmit(true, true, false, true);
        emit JobForwarder.Deposited(JOB, watcher, 10e6);
        vm.prank(watcher);
        fwd.deposit(JOB, 10e6);

        vm.expectEmit(true, true, false, true);
        emit JobForwarder.Forwarded(JOB, freelancer, 10e6);
        fwd.forward(JOB);
    }

    // --- helpers ----------------------------------------------------------------

    function _register() private {
        vm.prank(registrar);
        fwd.register(JOB, freelancer);
    }

    function _registerAndDeposit(uint256 amount) private {
        _register();
        vm.prank(watcher);
        fwd.deposit(JOB, amount);
    }
}
