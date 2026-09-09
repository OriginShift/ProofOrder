// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ProofOrderSettlement.sol";

contract ProofOrderSettlementTest is Test {
    ProofOrderSettlement settlement;
    address buyer = address(0xB0B);
    address provider = address(0xC0C);
    address payee = address(0xD0D);
    address verifier = address(0xE0E);
    bytes32 orderId = keccak256("order-1");
    bytes32 orderDigest = keccak256("digest-1");
    bytes32 commitment = keccak256("ciphertext-1");
    uint256 amount = 1 ether;

    function setUp() public {
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
        vm.prank(verifier);
        settlement.markVerified(orderId);
        uint256 beforeBalance = payee.balance;
        vm.prank(buyer);
        settlement.settle(orderId);
        assertEq(payee.balance, beforeBalance + amount);
        (, , , , , ProofOrderSettlement.State state, ,) = settlement.orders(orderId);
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
        vm.prank(verifier);
        settlement.markVerified(orderId);
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

    function testProviderCannotMarkVerifiedOrSettle() public {
        _fund();
        vm.prank(provider);
        settlement.submit(orderId, commitment);
        vm.prank(provider);
        vm.expectRevert(ProofOrderSettlement.Unauthorized.selector);
        settlement.markVerified(orderId);
    }
}
