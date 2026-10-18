# OfflinePay backend

Express + TypeScript backend for the OfflinePay demo. SQLite migrations run automatically on startup. Money is stored in integer paise and USDC base units.

## Local setup

From the repository root in PowerShell:

```powershell
Copy-Item backend/.env.example backend/.env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Paste the generated value into `JWT_SECRET`, then replace the gateway secret and both private key placeholders in `backend/.env`. `keys:generate` prints issuer and relayer keys and addresses without saving them:

```powershell
npm run keys:generate -w backend
```

For the fake-chain demo, keep `CHAIN_MODE=fake`. For a deployed contract setup, use the issuer and relayer keys and contract addresses supplied by P1. The Onramp.money gateway intentionally remains unconfigured until partner credentials and approved integration details exist.

Install workspace dependencies if needed, then start the API:

```powershell
npm install
npm run dev -w backend
```

Open [http://localhost:3000/health](http://localhost:3000/health); the default response is `{"status":"ok"}`.

## API flow with curl

The examples use `curl.exe` for PowerShell. `amountInr` is an integer number of rupees; API balances are returned in paise. Registration requires a physical-device integrity report. The mock KYC flow approves after about three seconds.

```powershell
$base = 'http://localhost:3000'
$registration = curl.exe -s -X POST "$base/v1/devices/register" `
  -H 'content-type: application/json' `
  --data '{"deviceAddress":"0x0000000000000000000000000000000000000001","deviceName":"Demo phone","integrity":{"rooted":false,"isDevice":true}}' | ConvertFrom-Json
$token = $registration.token
$auth = @{ Authorization = "Bearer $token" }

curl.exe -s "$base/v1/config"
curl.exe -s -X POST "$base/v1/kyc/start" -H "Authorization: Bearer $token"
Start-Sleep -Seconds 4
curl.exe -s "$base/v1/kyc/status" -H "Authorization: Bearer $token"
```

Create an onramp order, open the returned `paymentUrl` in a browser, then select **Pay** or **Fail**. The server-side mock gateway signs the event and sends it through the same webhook processor used by `POST /v1/webhooks/fiat`.

```powershell
$order = curl.exe -s -X POST "$base/v1/onramp/create" `
  -H "Authorization: Bearer $token" -H 'content-type: application/json' `
  --data '{"amountInr":1000}' | ConvertFrom-Json
$order.paymentUrl
```

After selecting **Pay**, issue vouchers against the funded order:

```powershell
curl.exe -s -X POST "$base/v1/vouchers/issue" `
  -H "Authorization: Bearer $token" -H 'content-type: application/json' `
  --data "{`"orderId`":`"$($order.orderId)`"}"
curl.exe -s "$base/v1/wallet" -H "Authorization: Bearer $token"
curl.exe -s "$base/v1/wallet/history" -H "Authorization: Bearer $token"
curl.exe -s -X POST "$base/v1/payee/vpa" -H "Authorization: Bearer $token" `
  -H 'content-type: application/json' --data '{"vpa":"demo.user@upi"}'
curl.exe -s "$base/v1/payouts" -H "Authorization: Bearer $token"
```

Ledger heads are submitted as a hash and monotonic integer counter:

```powershell
curl.exe -s -X POST "$base/v1/ledger/head" -H "Authorization: Bearer $token" `
  -H 'content-type: application/json' `
  --data '{"headHash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","counter":1}'
```

An observed counter decrease or a changed hash at the same counter freezes and revokes that device. This is a server-side rollback signal; it does not claim hardware-backed counter guarantees. The fake chain keeps collateral in memory, so restart it only for local demo use.

## Checks

```powershell
npm run typecheck -w backend
npm run test -w backend
```

`backend/src/chain/real/` remains reserved for P5. No real Onramp.money API endpoints are assumed here.
