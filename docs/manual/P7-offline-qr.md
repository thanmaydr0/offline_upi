# Offline QR transfer and balance check

## MANUAL STEPS FOR YOU

1. Install the same newly built APK on both Android phones and allow camera access.
2. While both phones are online, open OfflinePay on each and complete setup/sync. Load vouchers on the payer. Keep the receiver's device config and verified time current.
3. Put both phones in airplane mode. On the receiver, choose **Receive**, enter an amount within the payer's available voucher denominations, and show the OfflinePay request QR.
4. On the payer, choose **Pay**, scan that request, confirm the amount and payee, then approve with biometrics. Keep the proof screen open while the receiver scans every frame.
5. Wait for **Payment received** on the receiver. The payer's spendable offline balance is reduced locally; the receiver's locally saved incoming amount is pending settlement. Neither phone needs a running backend during these steps.
6. Reconnect later and sync to settle the received proof. A regular bank UPI QR is not an OfflinePay transfer QR and is not accepted by this offline flow.

## Validation

The mobile offline flow uses cached issuer/config data, local voucher storage, device signatures, QR frames, and a local received-proof store. Automated two-device flow coverage blocks network fetches. Camera scanning still needs verification on physical phones with the new APK.
