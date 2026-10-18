import { create } from 'zustand';

import { initialTransactions, type DemoTransaction } from '../services/mock/data';

type HistoryState = {
  transactions: DemoTransaction[];
  addTransaction: (transaction: DemoTransaction) => void;
  clearHistory: () => void;
};

export const useHistoryStore = create<HistoryState>((set) => ({
  transactions: [...initialTransactions],
  addTransaction: (transaction) =>
    set((state) => ({ transactions: [transaction, ...state.transactions] })),
  clearHistory: () => set({ transactions: [] }),
}));
