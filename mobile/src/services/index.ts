import { mockServices } from './mock';
import { keyService, voucherWallet, ledgerService, receivedStore } from '../core';
import { FetchApiClient } from '../api/client';
import { offlineFlows } from '../offline';

type ServiceBundle = typeof mockServices;

const useMocks = process.env.EXPO_PUBLIC_USE_MOCKS === '1';

const realServices: ServiceBundle = {
  keys: keyService, wallet: voucherWallet, ledger: ledgerService, received: receivedStore,
  api: new FetchApiClient({ keys: keyService }),
  offline: offlineFlows,
};

export const services: ServiceBundle = useMocks ? mockServices : realServices;
export const servicesMode = useMocks ? 'mock' : 'real';
