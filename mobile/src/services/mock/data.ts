import type { Address, Hex, StoredVoucher } from '@offline-pay/shared';

export const demoAddress = '0x1111111111111111111111111111111111111111' as Address;
const demoSignature = `0x${'ab'.repeat(65)}` as Hex;

export function createVoucher(inrPaise: number, serial: number): StoredVoucher {
  const voucherId = `0x${serial.toString(16).padStart(64, '0')}` as Hex;
  return {
    voucher: {
      voucherId,
      device: demoAddress,
      usdcAmount: (BigInt(inrPaise) * 1_000_000n) / 9_000n,
      inrPaise,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60),
    },
    issuerSig: demoSignature,
  };
}

export const initialVouchers: StoredVoucher[] = [
  createVoucher(50_000, 1),
  createVoucher(20_000, 2),
  createVoucher(10_000, 3),
  createVoucher(5_000, 4),
  createVoucher(2_000, 5),
  createVoucher(1_000, 6),
];

export type DemoTransaction = {
  id: string;
  title: string;
  subtitle: string;
  amountPaise: number;
  direction: 'in' | 'out';
  status: 'completed' | 'pending' | 'failed';
  date: string;
  icon: string;
};

export const initialTransactions: DemoTransaction[] = [
  { id: 'tx-1', title: 'Coffee House', subtitle: 'Today · 11:42 AM', amountPaise: 28500, direction: 'out', status: 'completed', date: 'Today', icon: '☕' },
  { id: 'tx-2', title: 'From Rahul Mehta', subtitle: 'Today · 9:16 AM', amountPaise: 125000, direction: 'in', status: 'completed', date: 'Today', icon: '↙' },
  { id: 'tx-3', title: 'Fresh Mart', subtitle: 'Yesterday · 7:08 PM', amountPaise: 64200, direction: 'out', status: 'completed', date: 'Yesterday', icon: '⌂' },
  { id: 'tx-4', title: 'Received offline', subtitle: 'Yesterday · 1:24 PM', amountPaise: 50000, direction: 'in', status: 'pending', date: 'Yesterday', icon: '↘' },
  { id: 'tx-5', title: 'Metro Cafe', subtitle: '16 Oct · 5:31 PM', amountPaise: 18000, direction: 'out', status: 'completed', date: 'Earlier', icon: '☕' },
];

export type PendingPayment = {
  id: string;
  senderName: string;
  amountPaise: number;
  receivedAt: string;
  risk: 'Low' | 'Medium';
};

export const initialPendingPayments: PendingPayment[] = [
  { id: 'pending-1', senderName: 'Rahul Mehta', amountPaise: 50000, receivedAt: 'Today · 9:42 AM', risk: 'Low' },
  { id: 'pending-2', senderName: 'Priya Shah', amountPaise: 20000, receivedAt: 'Yesterday · 6:18 PM', risk: 'Low' },
];
