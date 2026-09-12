// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal single-order settlement primitive for the G1 local-chain experiment.
/// The proof verifier is intentionally an explicit interface; a boolean submitted by a UI
/// is never accepted as verification evidence.
contract ProofOrderSettlement {
    uint64 public constant VERIFICATION_GRACE = 1 hours;
    enum State {
        None,
        Funded,
        Submitted,
        Verified,
        Settled,
        Refunded
    }

    struct Order {
        address buyer;
        address provider;
        address payee;
        uint256 amount;
        uint64 deadline;
        State state;
        bytes32 orderDigest;
        bytes32 ciphertextCommitment;
        bytes32 evidenceDigest;
    }

    mapping(bytes32 => Order) public orders;
    address public immutable verifier;

    constructor(address verifier_) {
        if (verifier_ == address(0)) revert InvalidOrder();
        verifier = verifier_;
    }

    error InvalidOrder();
    error InvalidState();
    error Unauthorized();
    error WrongValue();
    error DeadlineNotReached();
    error DeadlinePassed();
    error TransferFailed();
    error InvalidSignature();

    event Funded(bytes32 indexed orderId, address indexed buyer, uint256 amount);
    event Submitted(bytes32 indexed orderId, bytes32 ciphertextCommitment);
    event Verified(bytes32 indexed orderId);
    event Settled(bytes32 indexed orderId, address indexed payee, uint256 amount);
    event Refunded(bytes32 indexed orderId, address indexed buyer, uint256 amount);

    function fund(
        bytes32 orderId,
        bytes32 orderDigest,
        address provider,
        address payee,
        uint64 deadline
    ) external payable {
        if (orderId == bytes32(0) || orderDigest == bytes32(0) || provider == address(0) || payee == address(0)) {
            revert InvalidOrder();
        }
        if (orders[orderId].state != State.None || msg.value == 0 || deadline <= block.timestamp
            || deadline > type(uint64).max - VERIFICATION_GRACE) revert InvalidOrder();
        orders[orderId] = Order({
            buyer: msg.sender,
            provider: provider,
            payee: payee,
            amount: msg.value,
            deadline: deadline,
            state: State.Funded,
            orderDigest: orderDigest,
            ciphertextCommitment: bytes32(0),
            evidenceDigest: bytes32(0)
        });
        emit Funded(orderId, msg.sender, msg.value);
    }

    function submit(bytes32 orderId, bytes32 ciphertextCommitment) external {
        Order storage order = orders[orderId];
        if (order.state != State.Funded) revert InvalidState();
        if (msg.sender != order.provider) revert Unauthorized();
        if (block.timestamp >= order.deadline) revert DeadlinePassed();
        if (ciphertextCommitment == bytes32(0)) revert InvalidOrder();
        order.ciphertextCommitment = ciphertextCommitment;
        order.state = State.Submitted;
        emit Submitted(orderId, ciphertextCommitment);
    }

    function evidenceMessageHash(bytes32 orderId, bytes32 orderDigest, bytes32 ciphertextCommitment, bytes32 evidenceDigest) public view returns (bytes32) {
        return keccak256(abi.encodePacked("ProofOrder/VerificationEvidence/v1", block.chainid, address(this), orderId, orderDigest, ciphertextCommitment, evidenceDigest));
    }

    function markVerified(bytes32 orderId, bytes32 orderDigest, bytes32 ciphertextCommitment, bytes32 evidenceDigest, bytes calldata signature) external {
        Order storage order = orders[orderId];
        if (order.state != State.Submitted) revert InvalidState();
        if (block.timestamp >= uint256(order.deadline) + VERIFICATION_GRACE) revert DeadlinePassed();
        if (order.orderDigest != orderDigest || order.ciphertextCommitment != ciphertextCommitment || evidenceDigest == bytes32(0)) {
            revert InvalidOrder();
        }
        if (signature.length != 65) revert InvalidSignature();
        bytes32 message = evidenceMessageHash(orderId, orderDigest, ciphertextCommitment, evidenceDigest);
        bytes32 ethSignedMessage = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", message));
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (ecrecover(ethSignedMessage, v, r, s) != verifier) revert InvalidSignature();
        order.evidenceDigest = evidenceDigest;
        order.state = State.Verified;
        emit Verified(orderId);
    }

    function settle(bytes32 orderId) external {
        Order storage order = orders[orderId];
        if (order.state != State.Verified) revert InvalidState();
        if (msg.sender != order.buyer) revert Unauthorized();
        order.state = State.Settled;
        (bool ok,) = order.payee.call{value: order.amount}("");
        if (!ok) revert TransferFailed();
        emit Settled(orderId, order.payee, order.amount);
    }

    function refund(bytes32 orderId) external {
        Order storage order = orders[orderId];
        if (order.state != State.Funded && order.state != State.Submitted) revert InvalidState();
        if (msg.sender != order.buyer && msg.sender != order.provider) revert Unauthorized();
        uint256 refundDeadline = order.deadline;
        if (order.state == State.Submitted) refundDeadline = uint256(order.deadline) + VERIFICATION_GRACE;
        if (block.timestamp < refundDeadline) revert DeadlineNotReached();
        order.state = State.Refunded;
        (bool ok,) = order.buyer.call{value: order.amount}("");
        if (!ok) revert TransferFailed();
        emit Refunded(orderId, order.buyer, order.amount);
    }
}
