# Live Onramp integration

## Current state

On 2026-10-18, the signed-in Onramp dashboard showed App ID `2621907`. The live API request button was disabled with the condition that KYB and subscription must be completed. No live API key or secret was available. The ignored local backend configuration now selects `FIAT_GATEWAY=onramp`; it still uses Base Sepolia and cannot collect live INR.

The implementation uses hosted checkout with provider KYC and UPI, HMAC-SHA512 webhook authentication, authenticated merchant-history reconciliation, and finalized native-USDC transfer verification. It never accepts a browser redirect or the synthetic mock webhook as proof of payment. The server durably queues webhook notifications and reconciles every five seconds.

## MANUAL STEPS FOR YOU

1. Complete partner KYB and subscription/activation in the [Onramp dashboard](https://playground.onramp.money/dashboard/). Its Request Access button is currently disabled. Obtain the approved live API key/secret and confirm hosted INR/UPI support for this integration. GPay availability must be checked on a physical device through the provider's offered payment methods.
2. Configure secrets locally with `notepad backend\.env`. Keep `FIAT_GATEWAY=onramp` and `ONRAMP_APP_ID=2621907`. Add `ONRAMP_API_KEY`, `ONRAMP_API_SECRET`, `ONRAMP_NETWORK`, `ONRAMP_CHAIN_ID`, and `ONRAMP_COIN_ID` from the approved provider configuration. Provider chain IDs differ from EVM chain IDs. Do not paste secrets into chat or use EXPO_PUBLIC variables for them.
3. Before collecting money, deploy and verify the vault on a supported mainnet with native USDC and set `CHAIN_MODE=chain`, `RPC_URL`, `CHAIN_ID`, `VAULT_ADDRESS`, `USDC_ADDRESS`, issuer/relayer keys, and vault roles. The current Sepolia deployment must not be relabeled as mainnet. Mainnet deployment and gas funding involve real funds and were not performed. Checkout checks the RPC chain, vault token/issuer/operator and relayer gas before returning a payment URL.
4. Configure the approved live webhook endpoint as `https://<your-backend-host>/v1/webhooks/onramp` before accepting payment. A localhost or HTTP LAN URL is not sufficient. No public backend domain was configured in this session.
5. Finish the outstanding production work in `docs/handoff/P2-live-onramp.md`, including off-ramp and recovery. Then restart the backend with `npm run start -w backend`. Start the existing mobile development build with `$env:EXPO_PUBLIC_USE_MOCKS='0'; npm run start --prefix mobile -- --dev-client`. Point mobile Settings to the reachable HTTPS backend. Existing installed builds need the updated JavaScript before they can use provider KYC.
6. Run a user-authorized real transaction on a physical Android phone after activation and mainnet readiness. Confirm provider KYC, GPay/UPI handoff, provider transaction history, finalized USDC receipt, vault collateral funding and saved vouchers. No live transaction or GPay test was performed in this session.
7. The backend commit attempt was blocked by the SSH signing key passphrase. If committing these changes, unlock the configured key locally with `ssh-add "$env:USERPROFILE\.ssh\id_ed25519"`. Backend changes are staged; pre-existing staged mobile work was preserved. The small mobile changes from this session remain in the working tree above that staged work. Do not share the key passphrase in chat.

## Verification

- `npm run test -w backend`: 31 passed before the final two negative reconciliation tests were added; the final targeted Onramp/API run passed 25 tests.
- `npm run test --prefix mobile -- --config src/api/jest.config.cjs --runInBand`: 26 passed.
- Backend and mobile typecheck passed. Mobile ESLint passed. Backend has no lint script.
- Provider network/RPC calls in the new unit tests are controlled fixtures. The existing backend suite also passed its spawned Hardhat settlement tests. These checks do not prove live provider acceptance or real money operation.

## Operations and limits

Receipts in `review`, or left in `funding` after a crash, require operator reconciliation. Do not change them back to queued without checking the relayer journal and chain outcome: the existing funding API lacks a stable per-order idempotency key. An uncertain funding call is never retried automatically.

The existing fixed `INR_PER_USDC` voucher conversion remains in use. Onramp fees and exchange rates can leave net USDC below the required backing; such orders go to review without voucher issuance. Refunds, customer resolution of shortfall, and surplus ownership/accounting are not implemented. Confirm the pricing and recovery design before launch.

## Primary references

- [Hosted checkout parameters](https://docs.onramp.money/onramp/onramp-widget-integration/hosted-mode)
- [Provider webhook authentication and timing](https://docs.onramp.money/onramp/onramp-widget-integration/webhook-updates)
- [Authenticated request format](https://docs.onramp.money/onramp/rest-api-endpoints/sample-request-for-endpoints)
- [Merchant transaction history](https://docs.onramp.money/onramp/rest-api-endpoints/merchant-transaction-history)
- [Order status codes](https://docs.onramp.money/onramp/response-codes/order-status-codes)
- [Native USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)
