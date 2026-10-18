import { Router } from 'express';
import { authFromResponse, createAuthMiddleware } from '../auth.js';
import type { AppContext } from '../context.js';

/** Mount before walletRoutes until P2 integrates the credited balance into that route. */
export function settlementWalletRoutes(context: AppContext): Router {
  const router = Router();
  router.get('/v1/wallet', createAuthMiddleware(context.env, context.db), (_request, response) => {
    const { deviceId } = authFromResponse(response);
    const { db } = context;
    const funded = db.prepare("SELECT COALESCE(SUM(amount_inr_paise),0) AS amount FROM orders WHERE device_id = ? AND status = 'funded'").get(deviceId) as { amount: number };
    const vouchers = db.prepare('SELECT inr_paise, status FROM vouchers WHERE device_id = ?').all(deviceId) as { inr_paise: number; status: string }[];
    const credit = db.prepare('SELECT inr_paise FROM payee_online_balances WHERE device_id = ?').get(deviceId) as { inr_paise: number } | undefined;
    const pending = db.prepare("SELECT COALESCE(SUM(inr_paise),0) AS amount FROM received_items WHERE payee_device_id = ? AND status = 'pending'").get(deviceId) as { amount: number };
    response.json({ onlineInrPaise: Math.max(0, funded.amount - vouchers.reduce((sum, row) => sum + row.inr_paise, 0)) + (credit?.inr_paise ?? 0), offlineIssuedUnspentPaise: vouchers.filter(row => row.status === 'issued').reduce((sum, row) => sum + row.inr_paise, 0), pendingSettlementPaise: pending.amount });
  });
  return router;
}
