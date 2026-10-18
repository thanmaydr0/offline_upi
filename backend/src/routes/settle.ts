import { Router } from 'express';
import { z } from 'zod';
import { authFromResponse, createAuthMiddleware } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError, parse, uuidSchema } from '../http.js';
import { RealChain, vaultAbi } from '../chain/real/index.js';
import { SettlementService, settlementSchema } from './settle-service.js';

export function settleRoutes(context: AppContext, service = new SettlementService(context)): Router {
  const router = Router();
  const auth = createAuthMiddleware(context.env, context.db);
  router.post('/v1/settle', auth, async (request, response) => {
    const body = parse(settlementSchema, request.body as unknown);
    response.json(await service.settle(authFromResponse(response), body.items));
  });
  router.get('/v1/settle/:id', auth, (request, response) => {
    const id = parse(uuidSchema, request.params.id);
    const owner = context.db.prepare('SELECT payee_id FROM settlement_requests WHERE id = ?').get(id) as { payee_id: string } | undefined;
    if (!owner || owner.payee_id !== authFromResponse(response).deviceId) throw new HttpError(404, 'SETTLEMENT_NOT_FOUND', 'Settlement not found.');
    const exists = context.db.prepare("SELECT name FROM sqlite_master WHERE name = 'settlement_request_items'").get();
    const results = exists ? context.db.prepare('SELECT p.voucher_id AS voucherId, p.status FROM settlement_proofs p JOIN settlement_request_items r ON r.proof_id = p.id WHERE r.request_id = ?').all(id) : [];
    response.json({ settlementId: id, results });
  });
  const withdrawal = z.object({ amount: z.string().regex(/^[1-9][0-9]{0,77}$/) }).strict();
  router.post('/v1/settle/withdraw/request', auth, async (request, response) => {
    const body = parse(withdrawal, request.body as unknown);
    const caller = authFromResponse(response);
    if (!(context.chain instanceof RealChain)) throw new HttpError(503, 'CHAIN_REQUIRED', 'Withdrawal requires chain mode.');
    const device = context.db.prepare('SELECT frozen FROM devices WHERE id = ?').get(caller.deviceId) as { frozen: number };
    if (device.frozen) throw new HttpError(403, 'DEVICE_FROZEN', 'Frozen device cannot withdraw.');
    // P2 issuance checks frozen. Stop issuance before reserving collateral; do not freeze on chain,
    // since the vault must allow outstanding vouchers to redeem during the challenge delay.
    context.db.transaction(() => {
      context.db.prepare('UPDATE devices SET frozen = 1 WHERE id = ?').run(caller.deviceId);
      context.db.prepare("INSERT INTO collateral_withdrawals VALUES (?, ?, ?, 'requesting') ON CONFLICT(device_id) DO NOTHING").run(caller.deviceId, body.amount, caller.deviceAddress);
    })();
    await context.chain.requestWithdraw(caller.deviceAddress, BigInt(body.amount));
    context.db.prepare("UPDATE collateral_withdrawals SET status = 'pending' WHERE device_id = ?").run(caller.deviceId);
    const pending = await context.chain.publicClient.readContract({ address: context.chain.vault, abi: vaultAbi, functionName: 'pendingWithdraw', args: [caller.deviceAddress] }) as [bigint, bigint];
    response.json({ amount: pending[0].toString(), unlockAt: pending[1].toString() });
  });
  router.post('/v1/settle/withdraw/execute', auth, async (request, response) => {
    parse(z.object({}).strict(), request.body ?? {});
    const caller = authFromResponse(response);
    if (!(context.chain instanceof RealChain)) throw new HttpError(503, 'CHAIN_REQUIRED', 'Withdrawal requires chain mode.');
    const row = context.db.prepare("SELECT recipient FROM collateral_withdrawals WHERE device_id = ? AND status = 'pending'").get(caller.deviceId) as { recipient: `0x${string}` } | undefined;
    if (!row) throw new HttpError(409, 'WITHDRAWAL_NOT_PENDING', 'No pending withdrawal.');
    await context.chain.executeWithdraw(caller.deviceAddress, row.recipient);
    context.db.prepare("UPDATE collateral_withdrawals SET status = 'executed' WHERE device_id = ?").run(caller.deviceId);
    response.json({ status: 'executed' });
  });
  return router;
}
