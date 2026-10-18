# P6 handoff: show received offline balance on Home

The offline receive flow stores verified incoming proof locally in `services.received.pending()`. The P7 receive success screen can confirm the amount immediately, but the Home screen (P6-owned) currently reads only `services.wallet.offlineBalancePaise()`, so a receiver returning Home does not see incoming pending value there.

Please update the Home screen to sum `voucher.inrPaise` from `services.received.pending()` and display that amount as a separate **Received pending** balance. Refresh it when Home gains focus. Keep it separate from spendable offline vouchers and from the available total because an incoming proof cannot be spent again before settlement.
