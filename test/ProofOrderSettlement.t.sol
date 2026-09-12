// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProofOrderSettlement.sol";

contract ProofOrderSettlementTest is Test {
    ProofOrderSettlement settlement;
    address buyer = address(0xB0B);
    address provider = address(0xC0C);
    address payee = address(0xD0D);
    uint256 verifierPk = 0xA11CE;
    address verifier;
    bytes32 orderId = keccak256("order-1");
    bytes32 orderDigest = keccak256("digest-1");
    bytes32 commitment = keccak256("ciphertext-1");
    bytes32 evidenceDigest = keccak256("evidence-1");
    uint256 amount = 1 ether;

    function setUp() public {
        verifier = vm.addr(verifierPk);
        settlement = new ProofOrderSettlement(verifier);
        vm.deal(buyer, 10 ether);
        vm.deal(provider, 1 ether);
    }

    function _fund() internal {
        vm.prank(buyer);
        settlement.fund{value: amount}(orderId, orderDigest, provider, payee, uint64(block.timestamp + 1 days));
    }

    function testHappyPathPaysFixedPayee() public {
        _fund();
        vm.prank(provider);
        settlement.submit(orderId, commitment);
        settlement.markVerified(orderId, orderDigest, commitment, evidenceDigest, _signature());
        uint256 beforeBalance = payee.balance;
        vm.prank(buyer);
        settlement.settle(orderId);
        assertEq(payee.balance, beforeBalance + amount);
        (, , , , , ProofOrderSettlement.State state, , ,) = settlement.orders(orderId);
        assertEq(uint8(state), uint8(ProofOrderSettlement.State.Settled));
    }

    function testCannotSettleBeforeVerification() public {
        _fund();
        vm.prank(buyer);
        vm.expectRevert(ProofOrderSettlement.InvalidState.selector);
        settlement.settle(orderId);
    }

    function testRejectsDuplicateSubmitAndSettlement() public {
        _fund();
        vm.prank(provider);
        settlement.submit(orderId, commitment);
        vm.prank(provider);
        vm.expectRevert(ProofOrderSettlement.InvalidState.selector);
        settlement.submit(orderId, commitment);
        settlement.markVerified(orderId, orderDigest, commitment, evidenceDigest, _signature());
        vm.prank(buyer);
        settlement.settle(orderId);
        vm.prank(buyer);
        vm.expectRevert(ProofOrderSettlement.InvalidState.selector);
        settlement.settle(orderId);
    }

    function testTimeoutRefundReturnsFundsToBuyer() public {
        _fund();
        uint256 beforeBalance = buyer.balance;
        vm.warp(block.timestamp + 1 days);
        vm.prank(buyer);
        settlement.refund(orderId);
        assertEq(buyer.balance, beforeBalance + amount);
    }

    function testInvalidRelayerSignatureCannotMarkVerified() public {
        _fund();
        vm.prank(provider);
        settlement.submit(orderId, commitment);
        vm.prank(provider);
        vm.expectRevert(ProofOrderSettlement.InvalidSignature.selector);
        settlement.markVerified(orderId, orderDigest, commitment, evidenceDigest, hex"00");
    }

    function testVerifierCannotApproveMismatchedEvidence() public {
        _fund();
        vm.prank(provider);
        settlement.submit(orderId, commitment);
        vm.expectRevert(ProofOrderSettlement.InvalidSignature.selector);
        settlement.markVerified(orderId, orderDigest, commitment, evidenceDigest, hex"00");
    }

    function _signature() internal returns (bytes memory) {
        bytes32 digest = settlement.evidenceMessageHash(orderId, orderDigest, commitment, evidenceDigest);
        bytes32 signed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierPk, signed);
        return abi.encodePacked(r, s, v);
    }

    function testRejectsSignatureForDifferentEvidence() public {
        _fund();
        vm.prank(provider);
        settlement.submit(orderId, commitment);
        bytes32 wrongDigest = settlement.evidenceMessageHash(orderId, orderDigest, keccak256("other"), evidenceDigest);
        bytes32 signed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", wrongDigest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierPk, signed);
        vm.expectRevert(ProofOrderSettlement.InvalidSignature.selector);
        settlement.markVerified(orderId, orderDigest, commitment, evidenceDigest, abi.encodePacked(r, s, v));
    }

    function testEvidenceHashBindsChainId() public {
        bytes32 localHash = settlement.evidenceMessageHash(orderId, orderDigest, commitment, evidenceDigest);
        vm.chainId(1);
        bytes32 otherChainHash = settlement.evidenceMessageHash(orderId, orderDigest, commitment, evidenceDigest);
        assertTrue(localHash != otherChainHash);
    }
}
