import { create } from 'zustand';

import { initialPendingPayments, type PendingPayment } from '../services/mock/data';

type PendingState = {
  payments: PendingPayment[];
  removePayment: (id: string) => void;
  clearPayments: () => void;
};

export const usePendingStore = create<PendingState>((set) => ({
  payments: [...initialPendingPayments],
  removePayment: (id) => set((state) => ({ payments: state.payments.filter((payment) => payment.id !== id) })),
  clearPayments: () => set({ payments: [] }),
}));
