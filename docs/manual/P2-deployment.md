# Phone setup for the deployed demo

1. Open OfflinePay on each phone. In Settings, set Backend API URL to `https://offline-pay-api.onrender.com` and tap Save API URL.
2. Return to onboarding and register against the deployed server. Laptop accounts, sessions, balances, and vouchers were not migrated. Do not use old vouchers against the new server.
3. Allow time for a cold start after inactivity. Render warns that this may take 50 seconds or more. Retry once the health endpoint responds: `https://offline-pay-api.onrender.com/health`.
4. Rotate the imported credentials in both the ignored local configuration and Render environment: a Render accessibility response exposed masked values in tool output during deployment. Do not reuse these demo credentials for real funds.

This is a free demo using a fake chain and mock payments. Its SQLite records may be lost on restart or deployment, and fake-chain collateral resets on every process restart. No phone rebuild is required to change the API URL in Settings.

Dashboard: https://dashboard.render.com/web/srv-dbbrsrjl550s73e0j8ig
