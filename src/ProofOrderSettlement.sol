// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal single-order settlement primitive for the G1 local-chain experiment.
/// The proof verifier is intentionally an explicit interface; a boolean submitted by a UI
/// is never accepted as verification evidence.
contract ProofOrderSettlement {
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
        if (orders[orderId].state != State.None || msg.value == 0 || deadline <= block.timestamp) revert InvalidOrder();
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

    function markVerified(bytes32 orderId, bytes32 orderDigest, bytes32 ciphertextCommitment, bytes32 evidenceDigest) external {
        Order storage order = orders[orderId];
        if (order.state != State.Submitted) revert InvalidState();
        if (msg.sender != verifier) revert Unauthorized();
        if (order.orderDigest != orderDigest || order.ciphertextCommitment != ciphertextCommitment || evidenceDigest == bytes32(0)) {
            revert InvalidOrder();
        }
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
        if (block.timestamp < order.deadline) revert DeadlineNotReached();
        order.state = State.Refunded;
        (bool ok,) = order.buyer.call{value: order.amount}("");
        if (!ok) revert TransferFailed();
        emit Refunded(orderId, order.buyer, order.amount);
    }
}
