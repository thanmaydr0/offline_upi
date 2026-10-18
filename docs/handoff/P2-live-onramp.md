# Production work remaining after Onramp checkout implementation

The checkout/webhook path is implemented and local payment configuration selects Onramp. The partner dashboard has no live credentials yet and current contracts are testnet. This is not a completed production payment system.

## P5: funding recovery and settlement

- `RealChain.fundCollateral` uses a random journal key. Expose a stable merchant-order idempotency key and a receipt-based recovery API before enabling unattended recovery. Current reconciliation moves uncertain funding to review and never repeats it; a process death during funding leaves a durable `funding` receipt for manual recovery.
- The standard server still needs the existing settlement route/job integration. `CHAIN_MODE=chain` is now connected to `RealChain` through the standard context, but this alone does not mount settlement endpoints or implement customer cash-out.
- `OnrampMoneyGateway.createPayout` deliberately rejects VPA-only payout requests. A real Onramp off-ramp needs the provider's customer-authorized flow, bank/KYC mapping, crypto delivery and authenticated completion events. Implement the real flow before describing merchant INR cash-out as supported.
- Resolve provider fee/rate shortfalls and surplus accounting. The new worker credits only after a finalized USDC transfer supplies at least the backing required by existing voucher conversion. Shortfall is placed in review, not credited.

## P2: issuance recovery and operations

- Voucher issuance must recover the original signed vouchers on replay after response loss, as already documented in P6. The new payment adapter does not repair that existing API behavior.
- Add operator tooling for review receipts, refunds and crash recovery. Queued receipts retry; `review` and uncertain `funding` states require explicit reconciliation. No automated refund system exists.
- A withdrawal hash can credit only one order. Provider batched withdrawals need explicit allocation support before adoption.
- Merchant-history lookup is bounded to twenty pages of 500 records from the order creation window. Very high volume requires a more direct verified provider lookup or reliable cursor reconciliation.

## P4/P6: device completion

- Existing protocol-ID and persistence blockers documented in P6 remain to be verified/fixed in their owned paths.
- Mobile load balance now accepts `provider_required` KYC, completes KYC inside provider checkout, and retains reviewed orders without reopening payment or issuing vouchers.
- Verify GPay handoff, return/resume, process-death recovery and voucher issuance on a physical Android device after live activation. No new native dependencies or EAS build were introduced.
