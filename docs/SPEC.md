# OfflinePay SPEC (source of truth)

## 1. Concept
Offline "digital cash" backed by on-chain collateral.
- Online: user loads INR via UPI -> fiat gateway -> USDC locked as collateral in OfflineVault for the user's device address. Backend issues single-use, issuer-signed VOUCHERS (digital banknotes) bound to the device key.
- Offline: payer signs a Payment for each voucher; payee verifies purely with math (no network) and stores the proof.
- Online later: payee's app sends proofs to backend; relayer calls vault.redeemBatch; vault pays USDC to payee; backend off-ramps to INR.
SECURITY PRINCIPLE: no hardware counter is claimed. Double-spend is made BOUNDED and UNPROFITABLE: each voucher redeems at most once on-chain; total redeemable <= locked collateral; payee risk <= unsettled value; cheaters get frozen and blocklisted.

## 2. Defaults and env
- Chain: Base Sepolia (84532) for dev/demo; Base mainnet (8453) config exists, unused. Token: MockUSDC (6 decimals) on testnet.
- Gas: backend relayer pays gas. (ERC-4337 paymaster = roadmap only.)
- Fiat: MockGateway default (simulated UPI page + HMAC webhook). OnrampMoneyGateway = skeleton only (needs partner credentials; do not invent endpoints).
- Units: INR in paise (integer), USDC in 6-decimal base units. INR_PER_USDC (default 90) used only at voucher issuance.
- Denominations (paise): 100,200,500,1000,2000,5000,10000,20000,50000.
- Env vars (backend): PORT, DB_PATH, JWT_SECRET, CHAIN_MODE (fake|chain), RPC_URL, CHAIN_ID, VAULT_ADDRESS, USDC_ADDRESS, ISSUER_PRIVATE_KEY, RELAYER_PRIVATE_KEY, FIAT_GATEWAY (mock|onramp), FIAT_WEBHOOK_SECRET, ADMIN_USER, ADMIN_PASSWORD, INR_PER_USDC, MAX_OFFLINE_BALANCE_PAISE=500000, MAX_SINGLE_OFFLINE_PAYMENT_PAISE=200000, MAX_OFFLINE_SPEND_24H_PAISE=500000, VOUCHER_TTL_SECONDS=604800, PAYMENT_DEADLINE_SECONDS=604800, MERCHANT_MAX_UNSETTLED_PAISE=1000000, CLOCK_SKEW_SECONDS=300, WITHDRAW_DELAY_SECONDS=604800.
- Env vars (contracts): DEPLOYER_PRIVATE_KEY, RPC_URL_BASE_SEPOLIA, BASESCAN_API_KEY (optional).
- Env vars (mobile): EXPO_PUBLIC_API_URL, EXPO_PUBLIC_USE_MOCKS (1|0). API URL is also overridable at runtime in Settings (so LAN IP changes need no rebuild).

## 3. EIP-712
Domain: { name: "OfflineVault", version: "1", chainId, verifyingContract: <vault> }
Voucher(bytes32 voucherId, address device, uint256 usdcAmount, uint32 inrPaise, uint64 expiry)  signed by ISSUER
Payment(bytes32 voucherId, address device, address payee, uint256 usdcAmount, uint64 deadline)  signed by DEVICE key (secp256k1, ethers/viem style)
voucherId = 32 random bytes and is the single-use nonce. Hardened ECDSA (OpenZeppelin) only.

## 4. Contract OfflineVault (Solidity ^0.8.24, OpenZeppelin v5)
State: issuer, operator (relayer), usdc, collateral[device], redeemed[voucherId], frozen[device], pendingWithdraw[device]{amount,unlockAt}.
Functions:
- fundCollateral(device, amount): onlyOperator, pulls USDC via transferFrom.
- redeemBatch(Item[] items) returns uint8[] statuses: callable by anyone. Item = {Voucher v, bytes issuerSig, Payment p, bytes deviceSig}. One bad item must NOT revert the batch; return a status per item. On OK: mark redeemed, decrement collateral[device], transfer USDC to p.payee, emit Redeemed.
- Status codes: 0 OK, 1 ALREADY_REDEEMED, 2 BAD_ISSUER_SIG, 3 BAD_DEVICE_SIG, 4 VOUCHER_EXPIRED, 5 DEADLINE_PASSED, 6 DEVICE_FROZEN, 7 INSUFFICIENT_COLLATERAL, 8 FIELD_MISMATCH (voucherId/device/usdcAmount differ between v and p).
- freeze(device)/unfreeze(device): onlyOperator.
- requestWithdraw(device, amount) onlyOperator -> unlockAt = now + WITHDRAW_DELAY; executeWithdraw(device, to) after unlock. (Trust assumption: operator custody. Documented, not hidden.)
- setIssuer onlyOwner (Ownable2Step), pause/unpause onlyOwner. ReentrancyGuard + SafeERC20.

## 5. QR transport (CBOR, base64url, prefix "OPAY1:")
- PaymentRequest (payee -> payer): { v:1, payee, inrPaise, reqId(16 bytes), chainId, ts, name? }
- PaymentProof (payer -> payee): { v:1, reqId, items:[{ voucher, issuerSig, payment, deviceSig }] }
- If encoded > ~1800 chars, split into frames "OPAY1:<i>/<n>:<data>" shown as animated QR; receiver reassembles in any order.
- Voucher denominations combine to the EXACT amount (cash model). If exact change is impossible, the payer app says so and shows what it has.

## 6. Backend API (JSON REST, JWT bearer after register; all inputs zod-validated)
- POST /v1/devices/register {deviceAddress, deviceName, integrity:{rooted,isDevice}} -> {userId, token}
- GET /v1/config -> {issuerAddress, vaultAddress, usdcAddress, chainId, inrPerUsdc, denominations, limits, revokedDevices[], serverTime}
- POST /v1/kyc/start, GET /v1/kyc/status (mock: auto-approve after ~3s)
- POST /v1/onramp/create {amountInr} -> {orderId, paymentUrl, status}; GET /v1/onramp/:orderId
- GET /mock-upi/:orderId (HTML with Pay/Fail buttons) -> triggers signed webhook
- POST /v1/webhooks/fiat (HMAC) -> on success fund collateral via ChainClient, mark order funded
- POST /v1/vouchers/issue {orderId} -> {vouchers:[{voucher, issuerSig}]} (never issues more than funded collateral minus already issued)
- GET /v1/wallet -> {onlineInrPaise, offlineIssuedUnspentPaise, pendingSettlementPaise}
- POST /v1/ledger/head {headHash, counter} -> stores/validates device ledger head (rollback detection); returns ok or flagged
- POST /v1/settle {items:[...]} (payee auth) -> {settlementId, results:[{voucherId, status}]}; GET /v1/settle/:id
- GET /v1/payouts, GET /v1/wallet/history
- POST /v1/payee/vpa {vpa} (for off-ramp payout target)
- Admin (basic auth): GET /admin (flagged devices, double-spend attempts, payouts), POST /admin/freeze {device}
- ChainClient interface (FakeChain in-memory for tests/dev, RealChain via viem): fundCollateral, redeemBatch, freeze, getCollateral.
- FiatGateway interface: createOnramp, verifyWebhook, createPayout. MockGateway + OnrampMoneyGateway(skeleton).

## 7. Mobile architecture (Android only, Expo dev client, expo-router, zustand)
Folders: app/ (screens), src/ui, src/state, src/services (types.ts, index.ts wiring, mock/), src/core (keys, integrity, wallet, ledger, limits), src/api, src/offline (qr flows).
Interfaces in src/services/types.ts:
- KeyService { init(): Promise<{address}>; getAddress(); signPayments(payments: Payment[], reason: string): Promise<Hex[]> (ONE biometric prompt for the batch); integrity(): Promise<IntegrityReport> }
- VoucherWallet { list(); addIssued(items); selectForAmount(inrPaise): Promise<StoredVoucher[]|null> (enforces limits); markSpent(voucherIds, reqId); offlineBalancePaise() }
- LedgerService { append(entry); verifyChain(): Promise<{ok, brokenAt?}>; head(): Promise<{hash, counter}>; list() }
- ReceivedStore { addVerified(proof); pending(); markSettled(voucherId, status); seenVoucher(id) }
- ApiClient { register; getConfig; startKyc; kycStatus; createOnramp; onrampStatus; issueVouchers; getWallet; postLedgerHead; settle; history; payouts; setVpa }
- OfflineFlows { createRequest(inrPaise); payRequest(request): Promise<string[]> (QR frames); receiveFrame(frame): Promise<VerifyResult|{progress}> }
src/services/index.ts exports `services`, using mocks when EXPO_PUBLIC_USE_MOCKS=1.

## 8. Payee offline verification checklist (shared/verifyProof)
1. Decode + schema. 2. reqId matches the open request. 3. Each voucher signed by cached issuerAddress (from last sync). 4. Each payment signed by voucher.device. 5. payment.payee == my address. 6. usdcAmount/voucherId/device equal between voucher and payment. 7. Sum of inrPaise == requested amount. 8. voucher.expiry and payment.deadline in the future (allow CLOCK_SKEW_SECONDS). 9. device not in cached revokedDevices. 10. voucherId not seen before locally. 11. Risk caps: per-payment max and total unsettled <= MERCHANT_MAX_UNSETTLED_PAISE. Result carries a risk label (low/medium/high).

## 9. Ownership (each session edits ONLY its paths)
- P0: everything at bootstrap time (afterwards only docs/RULES.md and docs/SPEC.md owners are the user)
- P1: contracts/**, shared/src/abi/**
- P2: backend/** EXCEPT backend/src/chain/real/** and backend/src/jobs/**
- P3: mobile/app/**, mobile/src/ui/**, mobile/src/state/**, mobile/src/services/index.ts, mobile/src/services/mock/**
- P4: mobile/src/core/**, mobile/__tests__/core/**
- P5: backend/src/chain/real/**, backend/src/jobs/**, backend/src/routes/settle*, backend/scripts/**, backend tests for settlement
- P6: mobile/src/api/**, mobile/src/sync/**, edits to mobile/src/services/index.ts wiring, screens: Home, Load Balance, History, Settings, Pending (in mobile/app/**)
- P7: mobile/src/offline/**, screens: Pay, Receive (in mobile/app/** files named pay* / receive*)
- P8: tests/e2e/**, backend/src/admin/**, mobile/app/attack-lab*, security fixes via handoff notes
- P9: docs/** except RULES.md, SPEC.md
- P10: mobile/src/transport/**, docs/ble-spike.md

## 10. Security feature map
S1 collateral vault + single-use vouchers (P1,P2,P5). S2 biometric-gated device key in SecureStore (P4). S3 SQLCipher-encrypted DB, key in SecureStore (P4). S4 hash-chained ledger, head anchored in SecureStore + witnessed by server (P4,P6). S5 root/emulator/debug detection blocks offline mode (P4). S6 clock-rollback detection (P4). S7 per-payment and rolling 24h limits (P4). S8 payee risk caps + revocation list (P7). S9 freeze + blocklist on double-spend (P5). S10 attack lab demo (P8).