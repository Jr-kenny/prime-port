// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Wages flow OKX escrow -> ASP account -> this contract -> freelancer.
///
/// The whole point of this contract is what it cannot do. A job's payout
/// address is registered once, at hire time, from the signed hire commitment,
/// and can never be changed by anyone afterwards: no owner, no admin path,
/// no rescue function. Money deposited for a job has exactly one exit, and
/// `forward` is callable by anyone, so even if Prime Port disappears the
/// freelancer (or a friendly stranger) can push the payment through.
contract JobForwarder {
    /// USDT on XLayer. Handled with a safe-transfer wrapper because USDT
    /// deployments are historically loose about returning a bool.
    address public immutable token;

    /// The backend wallet that registers hires. It can only add new
    /// jobId -> payout mappings, never change existing ones.
    address public immutable registrar;

    mapping(bytes32 => address) public payoutOf;
    mapping(bytes32 => uint256) public balanceOf;

    event Registered(bytes32 indexed jobId, address indexed payout);
    event Deposited(bytes32 indexed jobId, address indexed from, uint256 amount);
    event Forwarded(bytes32 indexed jobId, address indexed payout, uint256 amount);

    error NotRegistrar();
    error ZeroPayout();
    error AlreadyRegistered();
    error UnregisteredJob();
    error ZeroAmount();
    error NothingToForward();
    error TransferFailed();

    constructor(address _token, address _registrar) {
        token = _token;
        registrar = _registrar;
    }

    /// Called by the backend during hire(), with the payout address the
    /// freelancer confirmed in the dual-signed hire commitment. Write-once.
    function register(bytes32 jobId, address payout) external {
        if (msg.sender != registrar) revert NotRegistrar();
        if (payout == address(0)) revert ZeroPayout();
        if (payoutOf[jobId] != address(0)) revert AlreadyRegistered();
        payoutOf[jobId] = payout;
        emit Registered(jobId, payout);
    }

    /// Anyone can fund a registered job; the release watcher does, right
    /// after the marketplace releases escrow to the ASP account. Deposits to
    /// unregistered jobs are refused so money can never enter without an
    /// exit already fixed.
    function deposit(bytes32 jobId, uint256 amount) external {
        if (payoutOf[jobId] == address(0)) revert UnregisteredJob();
        if (amount == 0) revert ZeroAmount();
        balanceOf[jobId] += amount;
        _safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(jobId, msg.sender, amount);
    }

    /// Callable by anyone. Pays the job's full credited balance to the
    /// registered address. No fee is taken here: Prime Port's fee is the
    /// posting fee, collected before any of this money existed.
    function forward(bytes32 jobId) external {
        address payout = payoutOf[jobId];
        if (payout == address(0)) revert UnregisteredJob();
        uint256 amount = balanceOf[jobId];
        if (amount == 0) revert NothingToForward();
        balanceOf[jobId] = 0;
        _safeTransfer(payout, amount);
        emit Forwarded(jobId, payout, amount);
    }

    /// USDT-tolerant transfers: succeed on empty returndata, require true
    /// when a bool is returned.
    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
