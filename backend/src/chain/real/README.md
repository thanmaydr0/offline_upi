# P5 chain and settlement runtime

Run from `backend/` until P2 registers the npm scripts and app wiring:

```powershell
npx tsx scripts/check-relayer.ts
npx tsx scripts/server-chain.ts
# Another terminal, same directory:
npx tsx scripts/seed-demo.ts
```

The ignored `.env` is already configured for the deployed Base Sepolia vault.
The seed performs registration, mock KYC and fiat payment, collateral funding,
voucher issuance, offline EIP-712 signing, settlement, and mock off-ramp payout.
Mock fiat and payout balances are demonstrations, not real bank transfers.

Local chain:

```powershell
npx tsx scripts/dev-chain.ts
# Another terminal, from backend/:
node --import tsx --env-file=.env --env-file=.env.local-chain scripts/server-chain.ts
node --import tsx --env-file=.env --env-file=.env.local-chain scripts/seed-demo.ts
```

The first command spawns Hardhat, deploys the compiled P1 artifacts, sets its
operator, seeds local token liquidity, prints addresses, and writes the ignored
`.env.local-chain`. It does not overwrite P1 deployment records or live `.env`.
Compile missing artifacts with `npm run compile -w contracts` from the root.
Do not run multiple relayer processes with the same key. The SQLite journal is
durable across restarts, but does not implement a distributed wallet lock.

`RealChain` reads the published shared ABIs. Live configuration comes from
`contracts/deployments/baseSepolia.json`; reconciliation starts at its deployment
block. Local tests deploy the same artifacts and use the local deployment start
block. RPC chain ID is checked before every write. Auto-minting occurs only on
84532; 31337 is pre-seeded separately; 8453 never invokes mint.

Transactions are serialized, use a persisted nonce, journal signed bytes before
broadcast, retry receipt waits, and replace pending transactions with 25% gas
price bumps. Replacement hashes are retained. A new transaction cannot skip an
unresolved persisted nonce. A settlement key is bound to its canonical payload.
Protect the SQLite file: signed transactions authorize their encoded actions.

The successful receipt's Redeemed logs are authoritative for OK. The current ABI
has no per-item failure events; failure codes are derived from simulation and are
best effort if another sender changes state before mining. No payout is made
without evidence of successful redemption. Historical deadline recovery decodes
direct redeemBatch transaction calldata; contract-wrapper redemptions would need
trace support or richer events. Two-block reconciliation lag is best effort and
is not a full finalized-chain/reorganization rollback implementation.

Settlement requests retain proofs and per-item results, deduplicate voucher IDs,
verify signatures, payee, fields, expiry, revocation and risk limits with shared
helpers, and relay chunks of at most 20. A second payee or different signed
deadline for a redeemed voucher causes an audit entry, revocation, and an
idempotent on-chain freeze. Same-payment retries reuse their existing payout.

Payout IDs are stable per redeemed proof. Production gateways must implement
provider idempotency using payoutId. The mock worker marks payouts paid after one
second, credits `payee_online_balances` exactly once, and updates payout/history
queries. `settlementWalletRoutes` includes these credits in the wallet response.
The zero-fee integer hook is in `SettlementService.payout`.

Reconciliation runs every three seconds, queries at most 200 blocks per RPC call,
persists a cursor only after processing, recovers missed receipts, retries payout
creation, completes mock payouts, and retries revoked-device freezes.

Authenticated withdrawal endpoints:

- `POST /v1/settle/withdraw/request {"amount":"<USDC base units>"}`
- `POST /v1/settle/withdraw/execute {}`

The request stops issuance with the existing DB frozen flag before calling the
vault. It does not freeze the vault device, so existing proofs can redeem during
the delay. The vault's seven-day delay is authoritative, regardless of a shorter
backend WITHDRAW_DELAY_SECONDS. The job executes matured withdrawals to the
authenticated device address; revoked devices cannot withdraw. Issuance remains
stopped afterwards; reactivation requires an explicit administrative workflow.

Validation: root `npm run typecheck -w backend`, `npm run test -w backend`.
Scripts also typecheck with the backend Express declaration included. No backend
lint configuration or lint script exists in the current workspace.
