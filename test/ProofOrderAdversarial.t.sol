// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProofOrderSettlement.sol";

/// Adversarial coverage for the frozen settlement contract: cross-order and cross-contract
/// signature replay, caller boundaries around every state transition, and the exact deadline/grace
/// boundaries. No contract behaviour is changed here; the tests only pin what the contract already
/// does.
contract ProofOrderAdversarialTest is Test {
    ProofOrderSettlement settlement;
    ProofOrderSettlement second; // same verifier, different address: a second settlement domain

    address buyer = address(0xB0B);
    address provider = address(0xC0C);
    address payee = address(0xD0D);
    address stranger = address(0xEEE);
    uint256 verifierPk = 0xA11CE;
    address verifier;

    bytes32 orderId = keccak256("adversarial-order");
    bytes32 orderDigest = keccak256("adversarial-digest");
    bytes32 commitment = keccak256("adversarial-ciphertext");
    bytes32 evidenceDigest = keccak256("adversarial-evidence");
    bytes32 secondOrderId = keccak256("adversarial-order-b");
    bytes32 secondDigest = keccak256("adversarial-digest-b");
    bytes32 secondCommitment = keccak256("adversarial-ciphertext-b");

    uint256 amount = 1 ether;
    uint64 deadline;

    function setUp() public {
        verifier = vm.addr(verifierPk);
        settlement = new ProofOrderSettlement(verifier);
        second = new ProofOrderSettlement(verifier);
        vm.deal(buyer, 20 ether);
        vm.deal(provider, 10 ether);
        deadline = uint64(block.timestamp + 1 days);
    }

    function _sign(uint256 pk, bytes32 message) internal returns (bytes memory) {
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", message));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethSigned);
        return abi.encodePacked(r, s, v);
    }

    function _signFor(ProofOrderSettlement target, bytes32 id, bytes32 digest, bytes32 commitment_, bytes32 evidence_)
        internal
        returns (bytes memory)
    {
        return _sign(verifierPk, target.evidenceMessageHash(id, digest, commitment_, evidence_));
    }

    function _fundAndSubmit(ProofOrderSettlement target, bytes32 id, bytes32 digest, bytes32 commitment_) internal {
        vm.prank(buyer);
        target.fund{value: amount}(id, digest, provider, payee, deadline);
        vm.prank(provider);
        target.submit(id, commitment_);
    }

    /// A signature over order A must not verify order B, even on the same contract.
    function testCrossOrderSignatureCannotVerifyAnotherOrder() public {
        _fundAndSubmit(settlement, orderId, orderDigest, commitment);
        _fundAndSubmit(settlement, secondOrderId, secondDigest, secondCommitment);
        bytes memory signatureForFirstOrder = _signFor(settlement, orderId, orderDigest, commitment, evidenceDigest);

        // Signatures cannot be redirected to a different order id.
        vm.expectRevert(ProofOrderSettlement.InvalidSignature.selector);
        settlement.markVerified(secondOrderId, secondDigest, secondCommitment, evidenceDigest, signatureForFirstOrder);

        // Nor can the digest or the ciphertext commitment be substituted for another order's.
        vm.expectRevert(ProofOrderSettlement.InvalidOrder.selector);
        settlement.markVerified(orderId, secondDigest, commitment, evidenceDigest, signatureForFirstOrder);

        vm.expectRevert(ProofOrderSettlement.InvalidOrder.selector);
        settlement.markVerified(orderId, orderDigest, secondCommitment, evidenceDigest, signatureForFirstOrder);

        // The original binding still verifies, so the rejections above are not vacuous.
        settlement.markVerified(orderId, orderDigest, commitment, evidenceDigest, signatureForFirstOrder);
        (,,,,, ProofOrderSettlement.State state,,,) = settlement.orders(orderId);
        assertEq(uint8(state), uint8(ProofOrderSettlement.State.Verified));
    }

    /// A signature produced for one settlement domain must not verify on another contract.
    function testSignatureCannotBeReplayedOntoAnotherContract() public {
        _fundAndSubmit(settlement, orderId, orderDigest, commitment);
        _fundAndSubmit(second, orderId, orderDigest, commitment);
        bytes memory signatureForFirstContract = _signFor(settlement, orderId, orderDigest, commitment, evidenceDigest);

        vm.expectRevert(ProofOrderSettlement.InvalidSignature.selector);
        second.markVerified(orderId, orderDigest, commitment, evidenceDigest, signatureForFirstContract);

        settlement.markVerified(orderId, orderDigest, commitment, evidenceDigest, signatureForFirstContract);
    }

    /// The evidence domain separates order ids and contract addresses.
    function testEvidenceMessageHashSeparatesOrderAndContract() public view {
        bytes32 base = settlement.evidenceMessageHash(orderId, orderDigest, commitment, evidenceDigest);
        bytes32 otherOrder = settlement.evidenceMessageHash(secondOrderId, orderDigest, commitment, evidenceDigest);
        bytes32 otherDigest = settlement.evidenceMessageHash(orderId, secondDigest, commitment, evidenceDigest);
        bytes32 otherCommitment = settlement.evidenceMessageHash(orderId, orderDigest, secondCommitment, evidenceDigest);
        bytes32 otherContract = second.evidenceMessageHash(orderId, orderDigest, commitment, evidenceDigest);

        assertTrue(base != otherOrder);
        assertTrue(base != otherDigest);
        assertTrue(base != otherCommitment);
        assertTrue(base != otherContract);
    }

    /// Only the named provider may submit, and only from the Funded state.
    function testOnlyProviderCanSubmit() public {
        _fundAndSubmit(settlement, orderId, orderDigest, commitment);

        bytes32 freshOrder = keccak256("fresh-for-callers");
        vm.prank(buyer);
        settlement.fund{value: amount}(freshOrder, orderDigest, provider, payee, deadline);

        vm.prank(stranger);
        vm.expectRevert(ProofOrderSettlement.Unauthorized.selector);
        settlement.submit(freshOrder, commitment);

        vm.prank(buyer);
        vm.expectRevert(ProofOrderSettlement.Unauthorized.selector);
        settlement.submit(freshOrder, commitment);
    }

    function testSubmitRejectsZeroCommitment() public {
        vm.prank(buyer);
        settlement.fund{value: amount}(orderId, orderDigest, provider, payee, deadline);
        vm.prank(provider);
        vm.expectRevert(ProofOrderSettlement.InvalidOrder.selector);
        settlement.submit(orderId, bytes32(0));
    }

    function testSubmitRejectsAfterDeadline() public {
        _fundAndSubmit(settlement, orderId, orderDigest, commitment);
        bytes32 lateOrder = keccak256("late-order");
        vm.prank(buyer);
        settlement.fund{value: amount}(lateOrder, orderDigest, provider, payee, deadline);
        vm.warp(uint256(deadline) + 1);
        vm.prank(provider);
        vm.expectRevert(ProofOrderSettlement.DeadlinePassed.selector);
        settlement.submit(lateOrder, commitment);
    }

    /// Any caller may relay a valid attestation, not only the verifier key holder.
    function testAnyCallerCanPublishAValidAttestation() public {
        _fundAndSubmit(settlement, orderId, orderDigest, commitment);
        bytes memory signature = _signFor(settlement, orderId, orderDigest, commitment, evidenceDigest);

        vm.prank(stranger);
        settlement.markVerified(orderId, orderDigest, commitment, evidenceDigest, signature);
        (,,,,, ProofOrderSettlement.State state,,,) = settlement.orders(orderId);
        assertEq(uint8(state), uint8(ProofOrderSettlement.State.Verified));
    }

    function testMarkVerifiedRejectsZeroEvidenceDigest() public {
        _fundAndSubmit(settlement, orderId, orderDigest, commitment);
        bytes memory signature = _signFor(settlement, orderId, orderDigest, commitment, bytes32(0));
        vm.expectRevert(ProofOrderSettlement.InvalidOrder.selector);
        settlement.markVerified(orderId, orderDigest, commitment, bytes32(0), signature);
    }

    function testMarkVerifiedRejectsMalformedSignatureLengths() public {
        _fundAndSubmit(settlement, orderId, orderDigest, commitment);
        bytes memory signature = _signFor(settlement, orderId, orderDigest, commitment, evidenceDigest);
        vm.expectRevert(ProofOrderSettlement.InvalidSignature.selector);
        settlement.markVerified(orderId, orderDigest, commitment, evidenceDigest, new bytes(64));
        vm.expectRevert(ProofOrderSettlement.InvalidSignature.selector);
        settlement.markVerified(orderId, orderDigest, commitment, evidenceDigest, bytes.concat(signature, hex"00"));
    }

    /// Exactly at the end of the verification grace is too late; one second earlier is allowed.
    function testVerificationGraceBoundaryIsExact() public {
        _fundAndSubmit(settlement, orderId, orderDigest, commitment);
        _fundAndSubmit(settlement, secondOrderId, secondDigest, secondCommitment);
        bytes memory firstSignature = _signFor(settlement, orderId, orderDigest, commitment, evidenceDigest);
        bytes memory secondSignature = _signFor(settlement, secondOrderId, secondDigest, secondCommitment, evidenceDigest);
        uint256 grace = uint256(settlement.VERIFICATION_GRACE());

        vm.warp(uint256(deadline) + grace - 1);
        settlement.markVerified(secondOrderId, secondDigest, secondCommitment, evidenceDigest, secondSignature);

        vm.warp(uint256(deadline) + grace);
        vm.expectRevert(ProofOrderSettlement.DeadlinePassed.selector);
        settlement.markVerified(orderId, orderDigest, commitment, evidenceDigest, firstSignature);
    }


    /// After the grace a submitted order can be refunded even by the provider, and the buyer keeps
    /// the escrow.
    function testProviderCanRefundSubmittedOrderAfterGraceToBuyer() public {
        _fundAndSubmit(settlement, orderId, orderDigest, commitment);
        vm.warp(uint256(deadline) + uint256(settlement.VERIFICATION_GRACE()));
        uint256 buyerBefore = buyer.balance;

        vm.prank(provider);
        settlement.refund(orderId);

        assertEq(buyer.balance, buyerBefore + amount);
        (,,,,, ProofOrderSettlement.State state,,,) = settlement.orders(orderId);
        assertEq(uint8(state), uint8(ProofOrderSettlement.State.Refunded));
    }

    /// Only the buyer or the provider may refund, and only after the order's own refund deadline.
    function testRefundCallerAndDeadlineBoundaries() public {
        _fundAndSubmit(settlement, orderId, orderDigest, commitment);

        vm.prank(stranger);
        vm.expectRevert(ProofOrderSettlement.Unauthorized.selector);
        settlement.refund(orderId);

        vm.prank(payee);
        vm.expectRevert(ProofOrderSettlement.Unauthorized.selector);
        settlement.refund(orderId);

        // A funded order can be refunded at exactly its deadline ...
        bytes32 fundedOrder = keccak256("funded-for-boundary");
        vm.prank(buyer);
        settlement.fund{value: amount}(fundedOrder, orderDigest, provider, payee, deadline);
        vm.warp(uint256(deadline) - 1);
        vm.prank(buyer);
        vm.expectRevert(ProofOrderSettlement.DeadlineNotReached.selector);
        settlement.refund(fundedOrder);
        vm.warp(uint256(deadline));
        vm.prank(buyer);
        settlement.refund(fundedOrder);

        // ... while a submitted order still waits out the verification grace.
        vm.prank(buyer);
        vm.expectRevert(ProofOrderSettlement.DeadlineNotReached.selector);
        settlement.refund(orderId);
    }

    /// Funding is one-shot per order id and refuses zero terms.
    function testFundRejectsSecondFundAndZeroTerms() public {
        vm.prank(buyer);
        settlement.fund{value: amount}(orderId, orderDigest, provider, payee, deadline);

        vm.prank(buyer);
        vm.expectRevert(ProofOrderSettlement.InvalidOrder.selector);
        settlement.fund{value: amount}(orderId, orderDigest, provider, payee, deadline);

        bytes32 zeroDigestOrder = keccak256("zero-digest");
        vm.startPrank(buyer);
        vm.expectRevert(ProofOrderSettlement.InvalidOrder.selector);
        settlement.fund{value: amount}(zeroDigestOrder, bytes32(0), provider, payee, deadline);
        vm.expectRevert(ProofOrderSettlement.InvalidOrder.selector);
        settlement.fund{value: amount}(zeroDigestOrder, orderDigest, address(0), payee, deadline);
        vm.expectRevert(ProofOrderSettlement.InvalidOrder.selector);
        settlement.fund{value: amount}(zeroDigestOrder, orderDigest, provider, address(0), deadline);
        vm.expectRevert(ProofOrderSettlement.InvalidOrder.selector);
        settlement.fund{value: 0}(zeroDigestOrder, orderDigest, provider, payee, deadline);
        vm.expectRevert(ProofOrderSettlement.InvalidOrder.selector);
        settlement.fund{value: amount}(bytes32(0), orderDigest, provider, payee, deadline);
        vm.stopPrank();
    }

    /// Settlement pays the immutable payee and never the caller.
    function testStrangerSettlementCannotRedirectTheFixedPayee() public {
        _fundAndSubmit(settlement, orderId, orderDigest, commitment);
        bytes memory signature = _signFor(settlement, orderId, orderDigest, commitment, evidenceDigest);
        settlement.markVerified(orderId, orderDigest, commitment, evidenceDigest, signature);

        uint256 payeeBefore = payee.balance;
        uint256 strangerBefore = stranger.balance;
        vm.prank(stranger);
        settlement.settle(orderId);

        assertEq(payee.balance, payeeBefore + amount);
        assertEq(stranger.balance, strangerBefore);
        assertEq(address(settlement).balance, 0);
    }
}
