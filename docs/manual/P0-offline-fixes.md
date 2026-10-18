# APK and two-phone validation

## MANUAL STEPS FOR YOU

1. When the new Expo preview build finishes, install that same APK on both Android
   phones. Do not uninstall an existing funded wallet or reset its local data.
2. Enroll supported biometrics, set the same reachable backend URL in Settings,
   and complete onboarding/config sync on each phone while online. Set the
   receiver's payout VPA before testing later settlement.
3. Load valid vouchers on the payer while online. Live loading requires approved
   Onramp credentials and a funded, correctly configured mainnet vault. Mock
   gateway mode is a simulated demo and never represents a real UPI payment.
4. Put both phones in airplane mode. On the receiver choose Receive and an amount
   that the payer can match with its voucher denominations. Scan that request
   with the payer, authorize it, then scan the payer's proof using the receiver.
   Keep the payer's proof visible until the receiver confirms receipt.
5. Reconnect the receiver and select Sync now. The updated backend must be running
   for settlement. Its normal command is `npm run start -w backend` from the
   repository root. A custom/mainnet vault additionally needs its deployment block
   in CHAIN_DEPLOYMENT_BLOCK. Real fiat payout requires a separately implemented
   provider-authorized off-ramp flow; this adapter leaves unsupported payouts pending.

Physical phone verification remains outstanding. Automated tests passing does
not certify cameras, biometric hardware or real provider payments. This task
submits the cloud build and does not monitor its completion, as requested.
