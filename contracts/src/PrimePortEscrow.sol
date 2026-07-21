// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PrimePortEscrow
/// @notice Minimal, non-custodial wage escrow for a dual-signed Prime Port hire.
/// @dev Negotiation, submissions, and revisions remain off-chain. This contract
///      only verifies the exact funding authorization and moves USD₮0 on the
///      happy path, a voluntary refund, or a finalized GenLayer resolution.
contract PrimePortEscrow {
    enum State {
        None,
        Funded,
        Disputed,
        Settled
    }

    enum Outcome {
        None,
        Released,
        Refunded,
        Resolved
    }

    struct Escrow {
        address buyer;
        address provider;
        address payout;
        uint256 amount;
        uint64 deadline;
        State state;
        Outcome outcome;
        bytes32 evidenceHash;
        bytes32 verdictHash;
    }

    /// @dev Domain-separates the structured authorization from every other
    ///      signature and binds it to one chain and one escrow deployment.
    bytes32 public constant AUTHORIZATION_TYPEHASH = keccak256(
        "PrimePortEscrowAuthorization(bytes32 commitmentHash,address buyer,address provider,address payout,address token,uint256 amount,uint64 deadline,uint256 chainId,address escrow)"
    );

    bytes4 private constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
    uint256 private constant SECP256K1N_DIV_2 = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public immutable token;
    address public immutable resolver;

    mapping(bytes32 commitmentHash => Escrow) public escrows;
    mapping(bytes32 resolutionId => bool) public usedResolutions;

    uint256 private unlocked = 1;

    event EscrowFunded(
        bytes32 indexed commitmentHash,
        address indexed buyer,
        address indexed provider,
        address payout,
        uint256 amount,
        uint64 deadline
    );
    event EscrowReleased(bytes32 indexed commitmentHash, address indexed payout, uint256 amount);
    event EscrowRefunded(bytes32 indexed commitmentHash, address indexed buyer, uint256 amount);
    event DisputeOpened(bytes32 indexed commitmentHash, address indexed openedBy, bytes32 indexed evidenceHash);
    event DisputeResolved(
        bytes32 indexed commitmentHash,
        bytes32 indexed resolutionId,
        bytes32 indexed verdictHash,
        uint16 providerBps,
        uint256 providerAmount,
        uint256 buyerAmount
    );

    error ZeroAddress();
    error ZeroAmount();
    error ZeroHash();
    error DeadlinePassed();
    error AlreadyExists();
    error InvalidSignature(address signer);
    error InvalidState(State expected, State actual);
    error NotBuyer();
    error NotProvider();
    error NotParty();
    error NotResolver();
    error InvalidBasisPoints();
    error ResolutionAlreadyUsed();
    error TransferFailed();
    error ReentrantCall();

    modifier nonReentrant() {
        if (unlocked != 1) revert ReentrantCall();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(address _token, address _resolver) {
        if (_token == address(0) || _resolver == address(0)) revert ZeroAddress();
        token = _token;
        resolver = _resolver;
    }

    /// @notice Lock the negotiated wage after both parties authorize the same
    ///         commitment, wallets, amount, deadline, chain, and contract.
    /// @dev Anyone may relay this transaction, but funds always come from the
    ///      signed buyer and require the buyer's ERC20 allowance.
    function fund(
        bytes32 commitmentHash,
        address buyer,
        address provider,
        address payout,
        uint256 amount,
        uint64 deadline,
        bytes calldata buyerSignature,
        bytes calldata providerSignature
    ) external nonReentrant {
        if (commitmentHash == bytes32(0)) revert ZeroHash();
        if (buyer == address(0) || provider == address(0) || payout == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert DeadlinePassed();
        if (escrows[commitmentHash].state != State.None) revert AlreadyExists();

        bytes32 digest = signatureDigest(authorizationHash(commitmentHash, buyer, provider, payout, amount, deadline));
        if (!_isValidSignature(buyer, digest, buyerSignature)) revert InvalidSignature(buyer);
        if (!_isValidSignature(provider, digest, providerSignature)) revert InvalidSignature(provider);

        escrows[commitmentHash] = Escrow({
            buyer: buyer,
            provider: provider,
            payout: payout,
            amount: amount,
            deadline: deadline,
            state: State.Funded,
            outcome: Outcome.None,
            evidenceHash: bytes32(0),
            verdictHash: bytes32(0)
        });
        _safeTransferFrom(buyer, address(this), amount);
        emit EscrowFunded(commitmentHash, buyer, provider, payout, amount, deadline);
    }

    /// @notice Buyer accepts the work and pays the provider in full.
    function release(bytes32 commitmentHash) external nonReentrant {
        Escrow storage escrow = escrows[commitmentHash];
        _requireState(escrow, State.Funded);
        if (msg.sender != escrow.buyer) revert NotBuyer();

        escrow.state = State.Settled;
        escrow.outcome = Outcome.Released;
        _safeTransfer(escrow.payout, escrow.amount);
        emit EscrowReleased(commitmentHash, escrow.payout, escrow.amount);
    }

    /// @notice Provider voluntarily cancels and returns the full wage.
    function refund(bytes32 commitmentHash) external nonReentrant {
        Escrow storage escrow = escrows[commitmentHash];
        _requireState(escrow, State.Funded);
        if (msg.sender != escrow.provider) revert NotProvider();

        escrow.state = State.Settled;
        escrow.outcome = Outcome.Refunded;
        _safeTransfer(escrow.buyer, escrow.amount);
        emit EscrowRefunded(commitmentHash, escrow.buyer, escrow.amount);
    }

    /// @notice Freeze normal settlement and commit to the evidence bundle
    ///         that GenLayer validators will evaluate.
    function openDispute(bytes32 commitmentHash, bytes32 evidenceHash) external {
        if (evidenceHash == bytes32(0)) revert ZeroHash();
        Escrow storage escrow = escrows[commitmentHash];
        _requireState(escrow, State.Funded);
        if (msg.sender != escrow.buyer && msg.sender != escrow.provider) revert NotParty();

        escrow.state = State.Disputed;
        escrow.evidenceHash = evidenceHash;
        emit DisputeOpened(commitmentHash, msg.sender, evidenceHash);
    }

    /// @notice Apply one finalized GenLayer verdict. The configured bridge
    ///         receiver is immutable, and resolution IDs cannot be replayed.
    function resolveDispute(bytes32 commitmentHash, bytes32 resolutionId, bytes32 verdictHash, uint16 providerBps)
        external
        nonReentrant
    {
        if (msg.sender != resolver) revert NotResolver();
        if (resolutionId == bytes32(0) || verdictHash == bytes32(0)) revert ZeroHash();
        if (providerBps > 10_000) revert InvalidBasisPoints();
        if (usedResolutions[resolutionId]) revert ResolutionAlreadyUsed();

        Escrow storage escrow = escrows[commitmentHash];
        _requireState(escrow, State.Disputed);
        usedResolutions[resolutionId] = true;

        uint256 providerAmount = escrow.amount * providerBps / 10_000;
        uint256 buyerAmount = escrow.amount - providerAmount;
        escrow.state = State.Settled;
        escrow.outcome = Outcome.Resolved;
        escrow.verdictHash = verdictHash;

        if (providerAmount != 0) _safeTransfer(escrow.payout, providerAmount);
        if (buyerAmount != 0) _safeTransfer(escrow.buyer, buyerAmount);
        emit DisputeResolved(commitmentHash, resolutionId, verdictHash, providerBps, providerAmount, buyerAmount);
    }

    function authorizationHash(
        bytes32 commitmentHash,
        address buyer,
        address provider,
        address payout,
        uint256 amount,
        uint64 deadline
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                AUTHORIZATION_TYPEHASH,
                commitmentHash,
                buyer,
                provider,
                payout,
                token,
                amount,
                deadline,
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Exact EIP-191 digest checked by `fund`.
    function signatureDigest(bytes32 authHash) public pure returns (bytes32) {
        bytes memory message = bytes(string.concat("Prime Port escrow authorization v1: ", _toHexString(authHash)));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n", _toString(message.length), message));
    }

    function authorizationMessage(bytes32 authHash) external pure returns (string memory) {
        return string.concat("Prime Port escrow authorization v1: ", _toHexString(authHash));
    }

    function _requireState(Escrow storage escrow, State expected) private view {
        if (escrow.state != expected) revert InvalidState(expected, escrow.state);
    }

    function _isValidSignature(address signer, bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (signer.code.length != 0) {
            (bool ok, bytes memory result) =
                signer.staticcall(abi.encodeWithSelector(ERC1271_MAGIC_VALUE, digest, signature));
            return ok && result.length >= 32 && bytes4(result) == ERC1271_MAGIC_VALUE;
        }
        return _recover(digest, signature) == signer;
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address recovered) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1N_DIV_2) return address(0);
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        recovered = ecrecover(digest, v, r, s);
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }

    function _toHexString(bytes32 value) private pure returns (string memory) {
        bytes16 symbols = "0123456789abcdef";
        bytes memory buffer = new bytes(66);
        buffer[0] = "0";
        buffer[1] = "x";
        for (uint256 i; i < 32; ++i) {
            uint8 b = uint8(value[i]);
            buffer[2 + i * 2] = symbols[b >> 4];
            buffer[3 + i * 2] = symbols[b & 0x0f];
        }
        return string(buffer);
    }

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        uint256 remaining = value;
        while (remaining != 0) {
            ++digits;
            remaining /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            buffer[--digits] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
        return string(buffer);
    }
}
