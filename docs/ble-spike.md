# Local Android payment transport

The implementation uses Android Classic Bluetooth secure RFCOMM sockets, not
BLE, Google Nearby Connections, or a custom RF waveform. Both devices must be
bonded once through Android settings. Only BLUETOOTH_CONNECT is requested on
Android 12+: there is no discovery or location permission. Bluetooth is RF;
Android does not expose a general-purpose arbitrary-waveform transmitter.

The native Expo module lives in mobile/modules/offline-link and is autolinked
from the default local modules directory. Its scanner uses pinned, bundled
ZXing Android Embedded 4.3.0. There is no Google Play API or model download in
the scanning path. It opens a portrait camera activity, with autofocus and torch
provided by ZXing, rather than Expo Camera's ML Kit analyzer.

## Exchange

Receiver creates a local request and a per-request receipt signing key stored in
SQLCipher. The OPAYBT1 QR carries the request plus the receipt public address.
The payer scans it, selects a bonded peer (remembered for future payments), and
opens a secure RFCOMM socket using service UUID
96d2f62b-479f-4ad7-84c2-68d52d74c5b3. A random connection challenge is signed by the receiver using the session key
and verified by the payer against the scanned QR before any vouchers are spent.
This binds the paired peer to the receiver, rather than trusting a Bluetooth name. After biometric approval the payer's durable
outbox stores the exact proof frames; the wallet commits spent vouchers.
The proof is sent with a 32-bit big-endian byte length and UTF-8 JSON frames.
Each native message is bounded to 256 KiB, application proof to 128 KiB/128
frames. Two incoming sockets are allowed, with bounded lifetimes.

Receiver JS serializes proof processing, checks session/request identity,
verifies issuer and device signatures from cached config, and commits received
credits and the exact original proof atomically in SQLite. It then signs an
EIP-191 acknowledgement using the receipt session key. The acknowledgement
binds chain ID, request ID, recipient, integer amount and keccak256 of the
complete proof. Payer verifies it against the key it scanned before displaying
Payment delivered. A disconnect is never a successful acknowledgement.

## Recovery and backend

The payer restores spent proof frames after process death or failed delivery.
No retry invokes payment signing or spends vouchers again. Exact receiver proof
records survive online settlement, so an acknowledgement lost on the radio can
be reissued without another incoming credit. New outgoing payments are blocked
while a deliverable proof remains. Incoming value is a pending received credit;
this single-hop voucher protocol cannot re-spend it offline.

Payment screens disable automatic backend synchronization. Home re-enables it
when an IP network is connected. On reconnection, sync uploads received proofs
in batches bounded by count and amount, then persists every settlement result
before acknowledging locally. Backend redemption does not require a payout
VPA; payout recovery runs once the user supplies one. This does not change bank
accounts while disconnected and does not prevent an offline double-spend on a
separate device; the vault resolves conflicts at settlement.

## Verification evidence and limits

Autolinking resolution confirms OfflineLinkModule and its Android source path.
Tests cover QR envelopes, real cryptographic receipts, forged/wrong-content
acknowledgements, payer outbox restart, receiver duplicate persistence, core
voucher spending/receipt persistence, and reconnect settlement batching.
No physical Android device is attached. Native camera, socket interoperability,
OEM restrictions, latency, and airplane-mode delivery require the manual two-
phone test in docs/manual/P7.md. These have not been claimed tested.

References: https://docs.expo.dev/modules/autolinking/
https://docs.expo.dev/modules/module-api/
https://developer.android.com/develop/connectivity/bluetooth/connect-bluetooth-devices
https://github.com/journeyapps/zxing-android-embedded/tree/v4.3.0
