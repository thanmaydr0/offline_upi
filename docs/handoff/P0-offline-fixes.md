# Offline payment integration fixes — 2026-10-18

This supersedes the request-ID, normal-server settlement, issuance retry, checkout
retry, HTTP mock checkout and mobile aggregate-test blockers in the older P6/P7 notes.

## Changes

- Payer wallet and received-proof storage use the protocol's 16-byte request IDs;
  voucher IDs remain 32 bytes. Invalid request IDs cannot consume vouchers.
- The standard backend mounts settlement/status routes and credited wallet reads.
  Its normal server starts both settlement and onramp reconciliation.
  Demo scripts and chain integration tests use the same application composition.
- Issuance retries return the exact original signatures and vouchers for the
  authenticated device/order, including the same wire types, without issuing twice.
- Checkout attempts are persisted before the network request. Process restart or
  response loss reuses the same order ID and amount; another device cannot reuse it.
- Successful redemption stays successful when a fiat payout submission fails;
  the payout remains durably pending for retry and is never displayed as paid.
- Chain reconciliation no longer depends on ignored contracts/deployments files.
  Local chains and the existing Base Sepolia demo vault have known starting blocks;
  other deployments set CHAIN_DEPLOYMENT_BLOCK.
- Home refreshes its local offline balance after spending instead of displaying
  a stale sync snapshot. The existing polyfills load before Expo Router starts.
- The key setup reports the need for supported biometrics before attempting
  SecureStore authentication; PIN-only devices cannot use this signing mechanism.
- Preview/development Android builds permit a LAN HTTP API URL; production
  requires HTTPS. Android backup is disabled to avoid restoring encrypted wallet
  data without its device-bound encryption/signing keys. SQLCipher stays enabled.
- Mock gateway pages no longer force HTTP LAN payment forms to HTTPS.
- The standard mobile test command runs core, API/sync, offline and UI suites
  serially, including a QR regression using the actual key signer, wallet, ledger,
  codec, verifier and received store with native APIs mocked.

## Validation

- npm test: shared 10, contracts 20, backend 36, mobile 85 tests passed (151 total).
- npm run typecheck: passed across all workspaces.
- npm run lint --prefix mobile: passed with zero warnings.
- Expo config introspection: preview cleartext true, production false,
  Android backup false and SQLCipher true.
- Android JavaScript export passed with the custom entry point (3,187 modules,
  Hermes bundle generated). Existing noble/hashes package-export fallback warnings remain.

## Remaining limits

Physical two-phone camera, biometric and airplane-mode behavior has not been
validated. Native APIs are mocked in automated tests. Both phones need online
initialization and cached config/time; the payer needs valid preissued vouchers.
Settlement needs reconnection. Reboot/clock-integrity checks can require online sync.
Use exact denominations; the wallet cannot split an issued voucher offline.
Keep the payer's proof screen open until the receiver confirms acceptance: recovery
of an undisplayed/lost proof after committed spending is not implemented.

Live funding needs an approved, correctly configured Onramp/mainnet deployment.
The current provider adapter cannot pay INR to a VPA alone: it requires a separate
customer-authorized off-ramp flow and verified bank details. Pending does not mean paid.
No live payment, deployment, provider setup or device reset was performed here.

The new EAS preview APK is submitted only after unsigned commits are pushed. The
user requested no cloud-build monitoring after submission.
