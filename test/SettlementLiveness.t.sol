// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProofOrderSettlement.sol";

contract RetryablePayee {
    bool public accepting;
    uint256 public payments;

    function acceptPayments() external {
        accepting = true;
    }

    receive() external payable {
        require(accepting, "payment disabled");
        payments++;
    }
}

contract ReentrantPayee {
    ProofOrderSettlement public immutable settlement;
    bytes32 public immutable orderId;
    uint256 public payments;
    bool public reentrySucceeded;
    bytes public reentryError;
    ProofOrderSettlement.State public stateDuringPayment;

    constructor(ProofOrderSettlement settlement_, bytes32 orderId_) {
        settlement = settlement_;
        orderId = orderId_;
    }

    receive() external payable {
        payments++;
        (,,,,, stateDuringPayment,,,) = settlement.orders(orderId);
        if (payments == 1) {
            (reentrySucceeded, reentryError) =
                address(settlement).call(abi.encodeCall(ProofOrderSettlement.settle, (orderId)));
        }
    }
}

contract SettlementLivenessTest is Test {
    ProofOrderSettlement settlement;
    address buyer = address(0xB0B);
    address provider = address(0xC0C);
    address payee = address(0xD0D);
    address relayer = address(0xE0E);
    uint256 verifierPk = 0xA11CE;
    address verifier;
    bytes32 orderId = keccak256("liveness-order");
    bytes32 orderDigest = keccak256("liveness-order-digest");
    bytes32 commitment = keccak256("liveness-ciphertext");
    bytes32 evidenceDigest = keccak256("liveness-evidence");
    uint256 amount = 1 ether;
    uint64 deadline;

    event Settled(bytes32 indexed orderId, address indexed payee, uint256 amount);

    function setUp() public {
        verifier = vm.addr(verifierPk);
        settlement = new ProofOrderSettlement(verifier);
        deadline = uint64(block.timestamp + 1 days);
        vm.deal(buyer, 10 ether);
        vm.deal(provider, 2 ether);
        vm.deal(payee, 3 ether);
        vm.deal(relayer, 4 ether);
    }

    function _fund(bytes32 id, address recipient, uint256 value) internal {
        vm.prank(buyer);
        settlement.fund{value: value}(id, orderDigest, provider, recipient, deadline);
    }

    function _submit(bytes32 id) internal {
        vm.prank(provider);
        settlement.submit(id, commitment);
    }

    function _verify(bytes32 id) internal {
        bytes32 message = settlement.evidenceMessageHash(id, orderDigest, commitment, evidenceDigest);
        bytes32 signed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", message));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierPk, signed);
        bytes memory signature = abi.encodePacked(r, s, v);
        vm.prank(verifier);
        settlement.markVerified(id, orderDigest, commitment, evidenceDigest, signature);
    }

    function _verifiedOrder(bytes32 id, address recipient, uint256 value) internal {
        _fund(id, recipient, value);
        _submit(id);
        _verify(id);
    }

    function _assertState(bytes32 id, ProofOrderSettlement.State expected) internal view {
        (,,,,, ProofOrderSettlement.State actual,,,) = settlement.orders(id);
        assertEq(uint8(actual), uint8(expected));
    }

    function _expectInvalidSettlement(bytes32 id) internal {
        vm.expectRevert(ProofOrderSettlement.InvalidState.selector);
        vm.prank(relayer);
        settlement.settle(id);
    }

    function testRelayerSettlesWithoutBuyerAfterFunding() public {
        _verifiedOrder(orderId, payee, amount);
        uint256 buyerBefore = buyer.balance;
        uint256 providerBefore = provider.balance;
        uint256 relayerBefore = relayer.balance;
        uint256 payeeBefore = payee.balance;

        vm.expectEmit(true, true, false, true, address(settlement));
        emit Settled(orderId, payee, amount);
        vm.prank(relayer);
        settlement.settle(orderId);

        _assertState(orderId, ProofOrderSettlement.State.Settled);
        assertEq(payee.balance, payeeBefore + amount);
        assertEq(buyer.balance, buyerBefore);
        assertEq(provider.balance, providerBefore);
        assertEq(relayer.balance, relayerBefore);
        assertEq(address(settlement).balance, 0);
    }

    function testProviderSettlesAfterVerificationGrace() public {
        _verifiedOrder(orderId, payee, amount);
        vm.warp(uint256(deadline) + settlement.VERIFICATION_GRACE() + 1 days);
        uint256 buyerBefore = buyer.balance;
        uint256 providerBefore = provider.balance;
        uint256 payeeBefore = payee.balance;

        vm.expectEmit(true, true, false, true, address(settlement));
        emit Settled(orderId, payee, amount);
        vm.prank(provider);
        settlement.settle(orderId);

        _assertState(orderId, ProofOrderSettlement.State.Settled);
        assertEq(payee.balance, payeeBefore + amount);
        assertEq(buyer.balance, buyerBefore);
        assertEq(provider.balance, providerBefore);
        assertEq(address(settlement).balance, 0);
    }

    function testBuyerCanStillSettle() public {
        _verifiedOrder(orderId, payee, amount);
        uint256 buyerBefore = buyer.balance;
        uint256 payeeBefore = payee.balance;
        vm.prank(buyer);
        settlement.settle(orderId);
        _assertState(orderId, ProofOrderSettlement.State.Settled);
        assertEq(payee.balance, payeeBefore + amount);
        assertEq(buyer.balance, buyerBefore);
    }

    function testCannotSettleUnfundedOrder() public {
        _expectInvalidSettlement(orderId);
        _assertState(orderId, ProofOrderSettlement.State.None);
    }

    function testCannotSettleFundedOrder() public {
        _fund(orderId, payee, amount);
        _expectInvalidSettlement(orderId);
        _assertState(orderId, ProofOrderSettlement.State.Funded);
        assertEq(address(settlement).balance, amount);
    }

    function testCannotSettleSubmittedOrder() public {
        _fund(orderId, payee, amount);
        _submit(orderId);
        _expectInvalidSettlement(orderId);
        _assertState(orderId, ProofOrderSettlement.State.Submitted);
        assertEq(address(settlement).balance, amount);
    }

    function testCannotSettleRefundedOrder() public {
        _fund(orderId, payee, amount);
        vm.warp(deadline);
        vm.prank(provider);
        settlement.refund(orderId);
        uint256 payeeBefore = payee.balance;
        _expectInvalidSettlement(orderId);
        _assertState(orderId, ProofOrderSettlement.State.Refunded);
        assertEq(buyer.balance, 10 ether);
        assertEq(payee.balance, payeeBefore);
        assertEq(address(settlement).balance, 0);
    }

    function testCannotSettleTwice() public {
        _verifiedOrder(orderId, payee, amount);
        vm.prank(relayer);
        settlement.settle(orderId);
        uint256 payeeAfter = payee.balance;
        _expectInvalidSettlement(orderId);
        _assertState(orderId, ProofOrderSettlement.State.Settled);
        assertEq(payee.balance, payeeAfter);
        assertEq(address(settlement).balance, 0);
    }

    function testVerifiedOrderCannotBeRefundedEvenAfterGrace() public {
        _verifiedOrder(orderId, payee, amount);
        vm.warp(uint256(deadline) + settlement.VERIFICATION_GRACE() + 1 days);
        uint256 buyerBefore = buyer.balance;
        uint256 payeeBefore = payee.balance;

        vm.expectRevert(ProofOrderSettlement.InvalidState.selector);
        vm.prank(buyer);
        settlement.refund(orderId);
        vm.expectRevert(ProofOrderSettlement.InvalidState.selector);
        vm.prank(provider);
        settlement.refund(orderId);

        _assertState(orderId, ProofOrderSettlement.State.Verified);
        assertEq(buyer.balance, buyerBefore);
        assertEq(payee.balance, payeeBefore);
        assertEq(address(settlement).balance, amount);
    }

    function testPayoutFailurePreservesVerifiedOrderAndCanBeRetried() public {
        RetryablePayee recipient = new RetryablePayee();
        _verifiedOrder(orderId, address(recipient), amount);
        uint256 buyerBefore = buyer.balance;
        uint256 relayerBefore = relayer.balance;

        vm.expectRevert(ProofOrderSettlement.TransferFailed.selector);
        vm.prank(relayer);
        settlement.settle(orderId);

        _assertState(orderId, ProofOrderSettlement.State.Verified);
        assertEq(address(settlement).balance, amount);
        assertEq(address(recipient).balance, 0);
        assertEq(recipient.payments(), 0);
        assertEq(buyer.balance, buyerBefore);
        assertEq(relayer.balance, relayerBefore);

        recipient.acceptPayments();
        vm.expectEmit(true, true, false, true, address(settlement));
        emit Settled(orderId, address(recipient), amount);
        vm.prank(provider);
        settlement.settle(orderId);

        _assertState(orderId, ProofOrderSettlement.State.Settled);
        assertEq(address(settlement).balance, 0);
        assertEq(address(recipient).balance, amount);
        assertEq(recipient.payments(), 1);
        assertEq(buyer.balance, buyerBefore);
    }

    function testReentrantPayeeCannotDoublePayOrSpendSecondOrder() public {
        ReentrantPayee recipient = new ReentrantPayee(settlement, orderId);
        bytes32 secondOrderId = keccak256("second-liveness-order");
        uint256 secondAmount = 2 ether;
        _verifiedOrder(orderId, address(recipient), amount);
        _verifiedOrder(secondOrderId, payee, secondAmount);
        uint256 payeeBefore = payee.balance;

        vm.prank(relayer);
        settlement.settle(orderId);

        assertEq(recipient.payments(), 1);
        assertFalse(recipient.reentrySucceeded());
        assertEq(recipient.reentryError(), abi.encodeWithSelector(ProofOrderSettlement.InvalidState.selector));
        assertEq(uint8(recipient.stateDuringPayment()), uint8(ProofOrderSettlement.State.Settled));
        assertEq(address(recipient).balance, amount);
        assertEq(payee.balance, payeeBefore);
        assertEq(address(settlement).balance, secondAmount);
        _assertState(orderId, ProofOrderSettlement.State.Settled);
        _assertState(secondOrderId, ProofOrderSettlement.State.Verified);

        vm.prank(relayer);
        settlement.settle(secondOrderId);
        assertEq(payee.balance, payeeBefore + secondAmount);
        assertEq(address(recipient).balance, amount);
        assertEq(address(settlement).balance, 0);
        _assertState(secondOrderId, ProofOrderSettlement.State.Settled);
    }

    function testFuzzArbitraryCallerCannotRedirectPayout(address caller, uint96 fundedValue) public {
        vm.assume(caller != payee && caller != address(settlement));
        uint256 value = bound(uint256(fundedValue), 1, 10 ether);
        _verifiedOrder(orderId, payee, value);
        uint256 callerBefore = caller.balance;
        uint256 buyerBefore = buyer.balance;
        uint256 payeeBefore = payee.balance;

        vm.prank(caller);
        settlement.settle(orderId);

        assertEq(caller.balance, callerBefore);
        assertEq(buyer.balance, buyerBefore);
        assertEq(payee.balance, payeeBefore + value);
        assertEq(address(settlement).balance, 0);
        _assertState(orderId, ProofOrderSettlement.State.Settled);
    }
}
