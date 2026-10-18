// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title OfflineVault
/// @notice Holds USDC collateral for device-bound, issuer-signed offline vouchers.
/// @dev Voucher redemption is bounded by device collateral and each voucherId is single use.
contract OfflineVault is EIP712, Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint8 public constant OK = 0;
    uint8 public constant ALREADY_REDEEMED = 1;
    uint8 public constant BAD_ISSUER_SIG = 2;
    uint8 public constant BAD_DEVICE_SIG = 3;
    uint8 public constant VOUCHER_EXPIRED = 4;
    uint8 public constant DEADLINE_PASSED = 5;
    uint8 public constant DEVICE_FROZEN = 6;
    uint8 public constant INSUFFICIENT_COLLATERAL = 7;
    uint8 public constant FIELD_MISMATCH = 8;

    uint64 public constant WITHDRAW_DELAY = 7 days;

    bytes32 private constant VOUCHER_TYPEHASH = keccak256(
        "Voucher(bytes32 voucherId,address device,uint256 usdcAmount,uint32 inrPaise,uint64 expiry)"
    );
    bytes32 private constant PAYMENT_TYPEHASH = keccak256(
        "Payment(bytes32 voucherId,address device,address payee,uint256 usdcAmount,uint64 deadline)"
    );

    struct Voucher {
        bytes32 voucherId;
        address device;
        uint256 usdcAmount;
        uint32 inrPaise;
        uint64 expiry;
    }

    struct Payment {
        bytes32 voucherId;
        address device;
        address payee;
        uint256 usdcAmount;
        uint64 deadline;
    }

    struct Item {
        Voucher voucher;
        bytes issuerSig;
        Payment payment;
        bytes deviceSig;
    }

    struct PendingWithdraw {
        uint256 amount;
        uint64 unlockAt;
    }

    address public issuer;
    address public operator;
    IERC20 public immutable usdc;

    mapping(address device => uint256 amount) public collateral;
    mapping(bytes32 voucherId => bool isRedeemed) public redeemed;
    mapping(address device => bool isFrozen) public frozen;
    mapping(address device => PendingWithdraw request) public pendingWithdraw;

    event IssuerUpdated(address indexed previousIssuer, address indexed newIssuer);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event CollateralFunded(address indexed device, uint256 amount);
    event Redeemed(bytes32 indexed voucherId, address indexed device, address indexed payee, uint256 amount);
    event DeviceFrozen(address indexed device);
    event DeviceUnfrozen(address indexed device);
    event WithdrawalRequested(address indexed device, uint256 amount, uint64 unlockAt);
    event WithdrawalExecuted(address indexed device, address indexed to, uint256 amount);

    error ZeroAddress();
    error InvalidAmount();
    error InsufficientCollateral();
    error NoPendingWithdrawal();
    error WithdrawalLocked(uint64 unlockAt);
    error DeviceIsFrozen();

    modifier onlyOperator() {
        require(msg.sender == operator, "OfflineVault: caller is not operator");
        _;
    }

    constructor(address initialOwner, address token, address initialIssuer)
        EIP712("OfflineVault", "1")
        Ownable(initialOwner)
    {
        if (token == address(0) || initialIssuer == address(0)) revert ZeroAddress();
        usdc = IERC20(token);
        issuer = initialIssuer;
    }

    /// @notice Set the voucher signing key. Only the current owner may rotate it.
    function setIssuer(address newIssuer) external onlyOwner {
        if (newIssuer == address(0)) revert ZeroAddress();
        address previousIssuer = issuer;
        issuer = newIssuer;
        emit IssuerUpdated(previousIssuer, newIssuer);
    }

    /// @notice Set the relayer allowed to fund, freeze and request withdrawals.
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        address previousOperator = operator;
        operator = newOperator;
        emit OperatorUpdated(previousOperator, newOperator);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Move USDC into this vault and credit it as a device's collateral.
    function fundCollateral(address device, uint256 amount)
        external
        onlyOperator
        whenNotPaused
        nonReentrant
    {
        if (device == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        collateral[device] += amount;
        emit CollateralFunded(device, amount);
    }

    /// @notice Redeem each valid item independently. Invalid vouchers return a status without reverting the batch.
    function redeemBatch(Item[] calldata items)
        external
        whenNotPaused
        nonReentrant
        returns (uint8[] memory statuses)
    {
        statuses = new uint8[](items.length);
        for (uint256 i = 0; i < items.length; ++i) {
            statuses[i] = _redeemOne(items[i]);
        }
    }

    /// @notice Freeze a device so none of its outstanding vouchers can redeem.
    function freeze(address device) external onlyOperator {
        if (device == address(0)) revert ZeroAddress();
        frozen[device] = true;
        emit DeviceFrozen(device);
    }

    function unfreeze(address device) external onlyOperator {
        if (device == address(0)) revert ZeroAddress();
        frozen[device] = false;
        emit DeviceUnfrozen(device);
    }

    /// @notice Start a delayed withdrawal of a device's collateral.
    /// @dev A new request replaces any outstanding request for that device.
    function requestWithdraw(address device, uint256 amount) external onlyOperator whenNotPaused {
        if (device == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        if (frozen[device]) revert DeviceIsFrozen();
        if (amount > collateral[device]) revert InsufficientCollateral();
        uint64 unlockAt = uint64(block.timestamp) + WITHDRAW_DELAY;
        pendingWithdraw[device] = PendingWithdraw({amount: amount, unlockAt: unlockAt});
        emit WithdrawalRequested(device, amount, unlockAt);
    }

    /// @notice Execute a matured delayed withdrawal to the requested recipient.
    function executeWithdraw(address device, address to)
        external
        onlyOperator
        whenNotPaused
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        if (frozen[device]) revert DeviceIsFrozen();
        PendingWithdraw memory request = pendingWithdraw[device];
        if (request.amount == 0) revert NoPendingWithdrawal();
        if (block.timestamp < request.unlockAt) revert WithdrawalLocked(request.unlockAt);

        delete pendingWithdraw[device];
        collateral[device] -= request.amount;
        usdc.safeTransfer(to, request.amount);
        emit WithdrawalExecuted(device, to, request.amount);
    }

    function _redeemOne(Item calldata item) private returns (uint8) {
        Voucher calldata voucher = item.voucher;
        Payment calldata payment = item.payment;

        if (redeemed[voucher.voucherId]) return ALREADY_REDEEMED;
        if (
            voucher.voucherId != payment.voucherId || voucher.device != payment.device
                || voucher.usdcAmount != payment.usdcAmount || voucher.device == address(0)
                || payment.payee == address(0)
        ) return FIELD_MISMATCH;
        if (_recoverVoucherSigner(voucher, item.issuerSig) != issuer) return BAD_ISSUER_SIG;
        if (_recoverPaymentSigner(payment, item.deviceSig) != voucher.device) return BAD_DEVICE_SIG;
        if (block.timestamp > voucher.expiry) return VOUCHER_EXPIRED;
        if (block.timestamp > payment.deadline) return DEADLINE_PASSED;
        if (frozen[voucher.device]) return DEVICE_FROZEN;
        uint256 reservedForWithdraw = pendingWithdraw[voucher.device].amount;
        if (collateral[voucher.device] < reservedForWithdraw || collateral[voucher.device] - reservedForWithdraw < voucher.usdcAmount) {
            return INSUFFICIENT_COLLATERAL;
        }

        redeemed[voucher.voucherId] = true;
        collateral[voucher.device] -= voucher.usdcAmount;
        usdc.safeTransfer(payment.payee, voucher.usdcAmount);
        emit Redeemed(voucher.voucherId, voucher.device, payment.payee, voucher.usdcAmount);
        return OK;
    }

    function _recoverVoucherSigner(Voucher calldata voucher, bytes calldata signature)
        private
        view
        returns (address)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                VOUCHER_TYPEHASH,
                voucher.voucherId,
                voucher.device,
                voucher.usdcAmount,
                voucher.inrPaise,
                voucher.expiry
            )
        );
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecover(_hashTypedDataV4(structHash), signature);
        return error == ECDSA.RecoverError.NoError ? signer : address(0);
    }

    function _recoverPaymentSigner(Payment calldata payment, bytes calldata signature)
        private
        view
        returns (address)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                PAYMENT_TYPEHASH,
                payment.voucherId,
                payment.device,
                payment.payee,
                payment.usdcAmount,
                payment.deadline
            )
        );
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecover(_hashTypedDataV4(structHash), signature);
        return error == ECDSA.RecoverError.NoError ? signer : address(0);
    }
}
