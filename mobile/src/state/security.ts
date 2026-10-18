import { create } from 'zustand';

type SecurityState = {
  biometricsEnrolled: boolean;
  deviceIntegrity: boolean;
  secureKeyReady: boolean;
  ledgerIntact: boolean;
  lastSync: string;
  setCheck: (key: 'biometricsEnrolled' | 'deviceIntegrity' | 'secureKeyReady' | 'ledgerIntact', value: boolean) => void;
  setLastSync: (value: string) => void;
};

export const useSecurityStore = create<SecurityState>((set) => ({
  biometricsEnrolled: true,
  deviceIntegrity: true,
  secureKeyReady: true,
  ledgerIntact: true,
  lastSync: 'Today, 9:42 AM',
  setCheck: (key, value) => set({ [key]: value }),
  setLastSync: (lastSync) => set({ lastSync }),
}));
