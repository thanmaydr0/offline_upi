import { create } from 'zustand';

type BalanceState = {
  onlinePaise: number;
  offlinePaise: number;
  pendingSettlementPaise: number;
  setBalances: (balances: { onlinePaise: number; offlinePaise: number; pendingSettlementPaise?: number }) => void;
  addOfflinePaise: (amountPaise: number) => void;
  spendOfflinePaise: (amountPaise: number) => void;
  addOnlinePaise: (amountPaise: number) => void;
};

export const useBalanceStore = create<BalanceState>((set) => ({
  onlinePaise: 4_623_800,
  offlinePaise: 88_000,
  pendingSettlementPaise: 70_000,
  setBalances: ({ onlinePaise, offlinePaise, pendingSettlementPaise }) =>
    set((state) => ({
      onlinePaise,
      offlinePaise,
      pendingSettlementPaise: pendingSettlementPaise ?? state.pendingSettlementPaise,
    })),
  addOfflinePaise: (amountPaise) => set((state) => ({ offlinePaise: state.offlinePaise + amountPaise })),
  spendOfflinePaise: (amountPaise) =>
    set((state) => ({ offlinePaise: Math.max(0, state.offlinePaise - amountPaise) })),
  addOnlinePaise: (amountPaise) => set((state) => ({ onlinePaise: state.onlinePaise + amountPaise })),
}));
